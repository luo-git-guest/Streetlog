"use strict";

const byId = id => document.getElementById(id);
const record = byId("record");
const locate = byId("locate");
const exportButton = byId("export");
const status = byId("status");
const hint = byId("hint");
const storagePrefix = "streetlog.outing.";
const gpsOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 };
const routingAttribution = 'Routing by <a href="https://routing.openstreetmap.de/about.html">FOSSGIS</a> · <a href="https://www.openstreetmap.org/fixthemap">Fix the map</a>';
const trailStyle = { color: "#ab2450", weight: 5, opacity: 0.92 };
const defaultHint = hint.textContent;

const matchBatchSize = 10;
let nextMatchRequest = 0;

function countMatchBatches(geometry) {
  switch (geometry?.type) {
    case "FeatureCollection":
      return geometry.features.reduce((sum, child) => sum + countMatchBatches(child), 0);
    case "Feature":
      return countMatchBatches(geometry.geometry);
    case "GeometryCollection":
      return geometry.geometries.reduce((sum, child) => sum + countMatchBatches(child), 0);
    case "MultiLineString":
      return geometry.coordinates.reduce((sum, line) =>
        sum + Math.max(0, Math.ceil((line.length - 1) / (matchBatchSize - 1))), 0);
    case "LineString":
      return Math.max(0, Math.ceil((geometry.coordinates.length - 1) / (matchBatchSize - 1)));
    default:
      return 0;
  }
}

async function matchStreetGeometry(data, cache, onProgress) {
  const total = onProgress ? countMatchBatches(data) : 0;
  if (total) onProgress(0, total);
  let matched = 0;
  let unmatched = 0;

  async function matchLine(coordinates) {
    const lines = [];
    // Overlap chunks by one point so adjacent requests use the same endpoint.
    for (let start = 0; start < coordinates.length - 1; start += matchBatchSize - 1) {
      const points = coordinates.slice(start, start + matchBatchSize);
      try {
        const positions = points.map(([lng, lat]) => {
          if (!Number.isFinite(lng) || !Number.isFinite(lat) ||
              Math.abs(lng) > 180 || Math.abs(lat) > 90) throw new Error("Invalid position");
          return [lng.toFixed(6), lat.toFixed(6)].join(",");
        }).join(";");
        const cached = cache?.get(positions);
        if (cached) {
          lines.push(cached);
          matched++;
          continue;
        }
        const radiuses = points.map(() => 20).join(";");
        const now = Date.now();
        const requestAt = Math.max(now, nextMatchRequest);
        nextMatchRequest = requestAt + 1000;
        if (requestAt > now) await new Promise(resolve => setTimeout(resolve, requestAt - now));
        const response = await fetch(
          "https://routing.openstreetmap.de/routed-foot/match/v1/driving/" + positions +
          "?geometries=geojson&overview=full&radiuses=" + radiuses,
          { signal: AbortSignal.timeout(15000) }
        );
        if (!response.ok) throw new Error("Routing service unavailable");
        const result = await response.json();
        if (result.code !== "Ok" || result.matchings.length !== 1 ||
            result.tracepoints.length !== points.length || result.tracepoints.some(point => !point)) {
          throw new Error("Incomplete street match");
        }
        const geometry = result.matchings[0].geometry;
        if (geometry?.type !== "LineString" || geometry.coordinates.length < 2) {
          throw new Error("Invalid snapped route");
        }
        cache?.set(positions, geometry.coordinates);
        lines.push(geometry.coordinates);
        matched++;
      } catch {
        lines.push(points);
        unmatched++;
      } finally {
        if (total) onProgress(matched + unmatched, total);
      }
    }
    return lines;
  }

  async function visit(value) {
    if (!value) return value;
    switch (value.type) {
      case "FeatureCollection": {
        const features = [];
        for (const feature of value.features) features.push(await visit(feature));
        return { ...value, features };
      }
      case "Feature":
        return { ...value, geometry: await visit(value.geometry) };
      case "GeometryCollection": {
        const geometries = [];
        for (const geometry of value.geometries) geometries.push(await visit(geometry));
        return { ...value, geometries };
      }
      case "LineString":
      case "MultiLineString": {
        const lines = value.type === "LineString" ? [value.coordinates] : value.coordinates;
        const coordinates = [];
        for (const line of lines) coordinates.push(...await matchLine(line));
        return { type: "MultiLineString", coordinates };
      }
      default:
        return value;
    }
  }

  return { data: await visit(data), matched, unmatched };
}

function nearestRouteSection(map, point, paths) {
  const target = map.project(point, 16);
  let nearest = null;
  for (const path of paths) {
    for (let index = 1; index < path.length; index++) {
      const start = map.project(path[index - 1], 16);
      const end = map.project(path[index], 16);
      const edge = end.subtract(start);
      const magnitude = edge.x ** 2 + edge.y ** 2;
      if (!magnitude) continue;
      const offset = target.subtract(start);
      const fraction = Math.max(0, Math.min(1, (offset.x * edge.x + offset.y * edge.y) / magnitude));
      const center = map.unproject(start.add(edge.multiplyBy(fraction)), 16);
      const distance = map.distance(point, center);
      if (!nearest || distance < nearest.distance) nearest = { path, index, center, distance };
    }
  }
  if (!nearest || nearest.distance > 50) return null;

  const { path, index, center } = nearest;
  function walk(direction) {
    let previous = center;
    let remaining = 14;
    const points = [];
    for (let i = direction < 0 ? index - 1 : index; i >= 0 && i < path.length; i += direction) {
      const next = L.latLng(path[i]);
      const length = map.distance(previous, next);
      if (length >= remaining) {
        const fraction = remaining / length;
        points.push(L.latLng(previous.lat + (next.lat - previous.lat) * fraction,
          previous.lng + (next.lng - previous.lng) * fraction));
        break;
      }
      points.push(next);
      remaining -= length;
      previous = next;
    }
    return points;
  }
  return { path, center, section: [...walk(-1).reverse(), center, ...walk(1)] };
}

function init() {
  if (!window.L) {
    status.textContent = "Map failed to load";
    hint.textContent = "Check your connection and reload.";
    record.disabled = locate.disabled = byId("import").disabled = byId("photos").disabled = true;
    return;
  }

  const map = L.map("map", { zoomControl: false }).setView([25.035, 121.539], 14);
  L.control.zoom({ position: "topright" }).addTo(map);
  L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    maxZoom: 19
  }).addTo(map);

  let routingAttributed = false;
  const imports = L.featureGroup().addTo(map);
  const importedPaths = [];
  const importLayers = new Map();
  const importedRoutes = [];
  const photos = [];
  const photoLayers = L.featureGroup().addTo(map);
  const selectionLayers = L.featureGroup().addTo(map);
  const photoSections = new Map();
  const photoButton = byId("photos");
  const photoFiles = byId("photo-files");
  const photoStatus = byId("photo-status");
  let rejectedPhotos = 0;
  let readingPhotos = false;

  function collectPaths(layer) {
    if (layer instanceof L.Polygon) return;
    if (layer instanceof L.Polyline) {
      const points = layer.getLatLngs();
      if (Array.isArray(points[0])) importedPaths.push(...points);
      else importedPaths.push(points);
    } else if (layer.eachLayer) layer.eachLayer(collectPaths);
  }

  function showPhotoSections() {
    if (!photos.length) {
      photoLayers.clearLayers();
      photoSections.clear();
      byId("photo-legend").hidden = true;
      return;
    }
    const paths = [...importedPaths, ...outings.flatMap(outing => outing.segments
      .flatMap((segment, index) => segment.length > 1 ? displayedPaths(outing, segment, index) : []))];
    const groups = [];
    let attached = 0;
    for (const photo of photos) {
      const match = nearestRouteSection(map, photo.point, paths);
      if (!match) continue;
      attached++;
      const group = groups.find(item => item.path === match.path &&
        map.distance(item.center, match.center) <= 28);
      if (group) group.photos.push(photo);
      else groups.push({ ...match, photos: [photo] });
    }

    photoLayers.clearLayers();
    photoSections.clear();
    for (const group of groups) {
      for (const photo of group.photos) photoSections.set(photo.id, group.section);
      const popup = document.createElement("div");
      popup.className = "photo-popup";
      const folderImages = [];
      for (const photo of group.photos) {
        const figure = document.createElement("figure");
        const image = document.createElement("img");
        const caption = document.createElement("figcaption");
        if (photo.getFile) folderImages.push({ image, photo });
        else image.src = photo.url;
        image.alt = photo.name;
        caption.textContent = photo.name;
        figure.append(image, caption);
        popup.append(figure);
      }
      L.polyline(group.section, { color: "#57390c", weight: 12, interactive: false })
        .addTo(photoLayers).bringToFront();
      const highlight = L.polyline(group.section, { color: "#ffd34e", weight: 8 })
        .addTo(photoLayers).bringToFront().bindPopup(popup, { maxWidth: 310 });
      let popupVersion = 0;
      const imageUrls = [];
      highlight.on("popupopen", async () => {
        const version = ++popupVersion;
        for (const { image, photo } of folderImages) {
          try {
            const file = await photo.getFile();
            if (popupVersion !== version) return;
            const url = URL.createObjectURL(file);
            imageUrls.push(url);
            image.src = url;
          } catch {
            if (popupVersion !== version) return;
            image.alt = `Could not open ${photo.name}`;
          }
        }
      });
      highlight.on("popupclose", () => {
        popupVersion++;
        for (const url of imageUrls.splice(0)) URL.revokeObjectURL(url);
        for (const { image } of folderImages) image.removeAttribute("src");
      });
      const path = highlight.getElement();
      path.setAttribute("tabindex", "0");
      path.setAttribute("role", "button");
      path.setAttribute("aria-label", group.photos.length === 1 ?
        `Open photo ${group.photos[0].name}` : `Open ${group.photos.length} route photos`);
      path.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          highlight.openPopup(group.center);
        }
      });
    }

    byId("photo-legend").hidden = attached === 0;
    if (!readingPhotos) {
      let message = `${attached} of ${photos.length} geotagged photos on a route.`;
      if (attached < photos.length) message += " Add a route within 50 m of the remaining photos.";
      if (rejectedPhotos) message += ` ${rejectedPhotos} files skipped because GPS metadata was missing or unreadable.`;
      photoStatus.textContent = message;
    }
    return groups;
  }

  photoButton.addEventListener("click", () => photoFiles.click());
  photoFiles.addEventListener("change", async () => {
    const files = [...photoFiles.files];
    photoFiles.value = "";
    if (!files.length) return;
    if (!window.exifr?.gps) {
      photoStatus.textContent = "The photo metadata reader did not load. Reload and try again.";
      return;
    }
    readingPhotos = true;
    photoButton.disabled = true;
    rejectedPhotos = 0;
    photoStatus.textContent = "Reading photo locations…";
    for (const file of files) {
      try {
        const gps = await window.exifr.gps(file);
        if (!Number.isFinite(gps?.latitude) || Math.abs(gps.latitude) > 90 ||
            !Number.isFinite(gps.longitude) || Math.abs(gps.longitude) > 180) throw new Error("Missing GPS");
        photos.push({ id: crypto.randomUUID(), point: L.latLng(gps.latitude, gps.longitude),
          name: file.name, file, url: URL.createObjectURL(file) });
      } catch {
        rejectedPhotos++;
      }
    }
    readingPhotos = false;
    photoButton.disabled = false;
    const groups = showPhotoSections();
    if (!groups) photoStatus.textContent = "No readable GPS metadata found. Choose a geotagged JPEG.";
    if (groups?.length) {
      const bounds = L.latLngBounds(groups.map(group => group.center));
      if (!map.getBounds().contains(bounds)) map.fitBounds(bounds, { maxZoom: 17, padding: [40, 40] });
    }
  });

  const importButton = byId("import");
  const fileInput = byId("geojson-file");
  const importStatus = byId("import-status");
  const importProgress = byId("import-progress");
  const snapStreets = byId("snap-streets");
  const snapPreferenceKey = "streetlog.snap-streets";
  try {
    snapStreets.checked = localStorage.getItem(snapPreferenceKey) !== "off";
  } catch {
    // The markup supplies the default when browser storage is unavailable.
  }
  snapStreets.addEventListener("change", () => {
    try {
      localStorage.setItem(snapPreferenceKey, snapStreets.checked ? "on" : "off");
    } catch {
      // The selection still applies for this visit.
    }
  });
  const importedStyle = { color: "#007985", weight: 5, opacity: 0.9 };

  function plotImportedRoute(route) {
    const layer = L.geoJSON(route.data, {
      style: importedStyle,
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
        ...importedStyle, radius: 6, fillOpacity: 0.9
      })
    });
    const bounds = layer.getBounds();
    if (!bounds.isValid()) return null;
    imports.addLayer(layer);
    importLayers.set(route.id, layer);
    collectPaths(layer);
    importedRoutes.push(route);
    byId("imported-legend").hidden = false;
    if (route.snapped) showRoutingAttribution();
    return bounds;
  }

  importButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileInput.value = "";
    importButton.disabled = true;
    const shouldSnap = snapStreets.checked;
    importProgress.removeAttribute("value");
    importProgress.hidden = false;
    importStatus.textContent = shouldSnap ? "Matching to streets…" : "Importing…";
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.type !== "string") throw new Error("Missing GeoJSON type");
      const result = shouldSnap ? await matchStreetGeometry(data, undefined, (done, total) => {
        importProgress.max = total;
        importProgress.value = done;
        importStatus.textContent = `Matching streets · ${done} of ${total} sections processed`;
      }) : { data };
      const bounds = plotImportedRoute({
        id: crypto.randomUUID(), name: file.name, data: result.data, snapped: Boolean(result.matched)
      });
      if (!bounds) {
        importStatus.textContent = "This file has no map features to display.";
        return;
      }
      showPhotoSections();
      map.fitBounds(bounds, { maxZoom: 17, padding: [30, 30] });
      let message = `Plotted ${file.name}.`;
      if (result.matched) message += " Street matching applied.";
      if (result.unmatched) message += " Unmatched sections use the original coordinates.";
      importStatus.textContent = message;
    } catch {
      importStatus.textContent = "Could not read this file. Choose valid GeoJSON.";
    } finally {
      importButton.disabled = false;
      importProgress.hidden = true;
    }
  });

  let outings = [];
  let current = null;
  let marker = null;
  let watch = null;
  let breakTrail = false;
  let lastFolderCheckpoint = 0;
  let routeLayer;
  let matchingRecording = false;
  let liveMatch = null;
  const pointCoords = point => [point.lat, point.lng];

  function displayedPaths(outing, segment, index) {
    const matched = outing.matchedSegments?.[index];
    if (matched) return matched.map(path => path.map(([lng, lat]) => [lat, lng]));
    const preview = liveMatch?.outing === outing ? liveMatch.segments.get(index) : null;
    if (!preview) return [segment.map(pointCoords)];
    const paths = preview.paths.map(path => path.map(([lng, lat]) => [lat, lng]));
    if (preview.offset < segment.length - 1) paths.push(segment.slice(preview.offset).map(pointCoords));
    return paths;
  }

  function showRoutingAttribution() {
    if (routingAttributed) return;
    map.attributionControl.addAttribution(routingAttribution);
    routingAttributed = true;
  }
  const distance = (first, second) => map.distance(pointCoords(first), pointCoords(second));

  function loadOutings() {
    return Object.keys(localStorage)
      .filter(key => key.startsWith(storagePrefix))
      .map(key => JSON.parse(localStorage.getItem(key)))
      .filter(outing => outing?.segments?.length);
  }

  const serverSelection = byId("server-selection");
  const deleteServerItem = byId("delete-server-item");
  const savedItems = { outings: new Map(), imports: new Map(), photos: new Map() };
  let serverBusy = false;

  function rememberSavedItems(library) {
    for (const [collection, entries] of Object.entries(library)) {
      if (!savedItems[collection]) continue;
      for (const entry of entries) savedItems[collection].set(entry.id, entry);
    }
  }

  function selectedServerItem() {
    if (!serverSelection.value) return null;
    const [collection, id] = JSON.parse(serverSelection.value);
    const entry = savedItems[collection].get(id);
    return entry ? { collection, id, entry, label: serverSelection.selectedOptions[0].textContent } : null;
  }

  function renderServerItems() {
    const previous = serverSelection.value;
    serverSelection.replaceChildren(new Option("Select a route or photo", ""));
    for (const [collection, entries] of Object.entries(savedItems)) {
      if (!entries.size) continue;
      const group = document.createElement("optgroup");
      group.label = { outings: "Recorded routes", imports: "Imported routes", photos: "Photos" }[collection];
      let index = 0;
      for (const [id, entry] of entries) {
        index++;
        const time = entry.segments?.[0]?.[0]?.time;
        const label = collection === "outings" && Number.isFinite(time)
          ? `Outing · ${new Date(time).toLocaleString()}`
          : entry.name || entry.data?.properties?.name || `${group.label.slice(0, -1)} ${index}`;
        group.append(new Option(label, JSON.stringify([collection, id])));
      }
      serverSelection.append(group);
    }
    if (previous) serverSelection.value = previous;
    serverSelection.disabled = serverBusy;
    deleteServerItem.disabled = serverBusy || !serverSelection.value;
  }

  function highlightServerItem(center = false) {
    selectionLayers.clearLayers();
    const selected = selectedServerItem();
    if (!selected) return;
    const style = { color: "#173690", weight: 12, dashArray: "5 8", interactive: false };
    if (selected.collection === "photos") {
      const section = photoSections.get(selected.id);
      if (section) L.polyline(section, style).addTo(selectionLayers).bringToFront();
      else if (center) map.setView([selected.entry.lat, selected.entry.lng], Math.max(map.getZoom(), 16));
    } else {
      const data = selected.collection === "outings"
        ? { type: "FeatureCollection", features: outingFeatures(selected.entry) } : selected.entry.data;
      L.geoJSON(data, {
        style,
        pointToLayer: (_feature, point) => L.circleMarker(point, { ...style, dashArray: null, radius: 6, weight: 4 })
      }).addTo(selectionLayers).bringToFront();
    }
    if (center && selectionLayers.getBounds().isValid()) {
      map.fitBounds(selectionLayers.getBounds(), { maxZoom: 17, padding: [35, 35] });
    }
  }

  function refreshMap() {
    routeLayer?.remove();
    routeLayer = L.featureGroup().addTo(map);
    let meters = 0;
    for (const outing of outings) {
      if (outing.matchedSegments) showRoutingAttribution();
      for (const [segmentIndex, segment] of outing.segments.entries()) {
        if (segment.length === 1) {
          L.circleMarker(pointCoords(segment[0]), {
            ...trailStyle, radius: 4, fillOpacity: 1, interactive: false
          }).addTo(routeLayer);
        } else {
          for (const path of displayedPaths(outing, segment, segmentIndex)) {
            L.polyline(path, { ...trailStyle, interactive: false }).addTo(routeLayer);
            for (let index = 1; index < path.length; index++) {
              meters += map.distance(path[index - 1], path[index]);
            }
          }
        }
      }
    }
    byId("distance").textContent = (meters / 1000).toFixed(2);
    byId("outings").textContent = outings.length;
    exportButton.disabled = outings.length === 0;
    showPhotoSections();
    highlightServerItem();
  }

  try {
    outings = loadOutings();
  } catch {
    status.textContent = "Browser storage unavailable";
    record.disabled = true;
  }
  refreshMap();
  if (routeLayer.getBounds().isValid()) {
    map.fitBounds(routeLayer.getBounds(), { maxZoom: 17, padding: [30, 30] });
  }

  const saveLibrary = byId("save-library");
  const libraryStatus = byId("library-status");

  async function restoreLibrary() {
    try {
      const response = await fetch("/api/library");
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return;
      const library = await response.json();
      const merged = new Map(library.outings.map(outing => [outing.id, outing]));
      for (const outing of outings) {
        const serverOuting = merged.get(outing.id);
        const count = segments => segments.reduce((total, segment) => total + segment.length, 0);
        if (!serverOuting || outing === current ||
            count(outing.segments) > count(serverOuting.segments) ||
            (count(outing.segments) === count(serverOuting.segments) &&
             (outing.matchedSegments || !serverOuting.matchedSegments))) merged.set(outing.id, outing);
      }
      outings = [...merged.values()];
      rememberSavedItems(library);
      renderServerItems();
      byId("server-items").hidden = false;
      for (const route of library.imports) plotImportedRoute(route);
      for (const photo of library.photos) {
        photos.push({ ...photo, point: L.latLng(photo.lat, photo.lng), url: photo.image, serverSaved: true });
      }
      refreshMap();
      const bounds = routeLayer.getBounds().extend(imports.getBounds());
      if (bounds.isValid() && !current) map.fitBounds(bounds, { maxZoom: 17, padding: [30, 30] });
      saveLibrary.hidden = false;
      saveLibrary.disabled = false;
      libraryStatus.textContent = library.outings.length || library.imports.length || library.photos.length
        ? "Saved routes and photos loaded from this computer."
        : "Save a copy of your routes and photos on this computer’s server.";
    } catch {
      libraryStatus.textContent = "Could not load the server library. Browser GPS history is still available.";
    }
  }

  saveLibrary.addEventListener("click", async () => {
    if (readingPhotos || importButton.disabled || matchingRecording) {
      libraryStatus.textContent = "Wait for importing or street matching to finish, then save.";
      return;
    }
    serverBusy = true;
    renderServerItems();
    saveLibrary.disabled = true;
    libraryStatus.textContent = "Saving routes and photos…";
    const entries = photos.filter(photo => !photo.serverSaved);
    try {
      const savedPhotos = await Promise.all(entries.map(async photo => {
        const file = photo.file ?? (photo.getFile ? await photo.getFile() : await (await fetch(photo.url)).blob());
        const image = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(new Blob([file], { type: "image/jpeg" }));
        });
        return { id: photo.id, name: photo.name, lat: photo.point.lat, lng: photo.point.lng, image };
      }));
      const payload = { outings, imports: importedRoutes, photos: savedPhotos };
      const body = JSON.stringify(payload);
      const response = await fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Server save failed.");
      }
      for (const photo of entries) photo.serverSaved = true;
      rememberSavedItems(JSON.parse(body));
      libraryStatus.textContent = "Routes and photos saved to the server.";
    } catch (error) {
      libraryStatus.textContent = `Save failed. ${error.message}`;
    } finally {
      serverBusy = false;
      saveLibrary.disabled = false;
      renderServerItems();
    }
  });

  serverSelection.addEventListener("change", () => {
    deleteServerItem.disabled = !serverSelection.value;
    highlightServerItem(true);
  });

  deleteServerItem.addEventListener("click", async () => {
    const selected = selectedServerItem();
    if (!selected || serverBusy) return;
    if (current || matchingRecording || readingPhotos || importButton.disabled) {
      libraryStatus.textContent = "Finish recording, matching, or importing before deleting.";
      return;
    }
    if (!window.confirm(`Delete ${selected.label} from the server library? Copies in the browser or local folder are kept.`)) return;
    const { collection, id } = selected;
    serverBusy = true;
    saveLibrary.disabled = true;
    renderServerItems();
    libraryStatus.textContent = "Deleting the selected item…";
    try {
      const response = await fetch("/api/library", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection, id })
      });
      if (!response.ok) throw new Error((await response.json()).error);
      savedItems[collection].delete(id);
      if (collection === "outings") {
        outings = outings.filter(outing => outing.id !== id);
      } else if (collection === "imports") {
        const index = importedRoutes.findIndex(route => route.id === id);
        if (index >= 0) importedRoutes.splice(index, 1);
        const layer = importLayers.get(id);
        if (layer) imports.removeLayer(layer);
        importLayers.delete(id);
        importedPaths.length = 0;
        imports.eachLayer(collectPaths);
        byId("imported-legend").hidden = !importLayers.size;
      } else {
        const index = photos.findIndex(photo => photo.id === id);
        if (index >= 0) {
          const [photo] = photos.splice(index, 1);
          if (photo.url?.startsWith("blob:")) URL.revokeObjectURL(photo.url);
        }
        if (!photos.length) photoStatus.textContent = "";
      }
      serverSelection.value = "";
      refreshMap();
      libraryStatus.textContent = "Selected item deleted from the server.";
    } catch (error) {
      libraryStatus.textContent = `Delete failed. ${error.message}`;
    } finally {
      serverBusy = false;
      saveLibrary.disabled = false;
      renderServerItems();
    }
  });

  const openFolder = byId("open-folder");
  const reconnectFolder = byId("reopen-folder");
  const folderFiles = byId("folder-files");
  const saveFolder = byId("save-folder");
  const folderStatus = byId("folder-status");
  const folderProgress = byId("folder-progress");
  const serverFolderForm = byId("server-folder-form");
  const serverFolderPath = byId("server-folder-path");
  const folderPermission = { mode: "readwrite" };
  let activeFolder = null;
  let rememberedFolder = null;
  let folderWrite = Promise.resolve();
  let folderBusy = false;

  function mergeOuting(outing) {
    const index = outings.findIndex(existing => existing.id === outing.id);
    if (index < 0) {
      outings.push(outing);
      return;
    }
    const existing = outings[index];
    const count = item => item.segments.reduce((sum, segment) => sum + segment.length, 0);
    if (existing !== current && (count(outing) > count(existing) ||
        (count(outing) === count(existing) && outing.matchedSegments && !existing.matchedSegments))) {
      outings[index] = outing;
    }
  }

  function photoFileId(name) {
    const stored = /^streetlog-([a-f0-9-]{36})\.(?:jpg|jpeg)$/i.exec(name);
    return stored ? stored[1] : `folder-photo:${name}`;
  }

  async function loadFolder(files) {
    let skipped = 0;
    let unmatched = 0;
    let done = 0;
    const total = files.routes.length + files.photos.length;
    const shouldSnap = snapStreets.checked;
    const progress = (matched, batches) => {
      folderProgress.value = done + matched / batches;
      folderStatus.textContent = `Matching streets · File ${done + 1} of ${total} · ${matched} of ${batches} sections processed`;
    };
    folderProgress.max = Math.max(1, total);
    folderProgress.value = 0;
    for (const entry of files.routes) {
      try {
        const data = JSON.parse(await (await entry.getFile()).text());
        const saved = data.streetlogOuting;
        if (saved && typeof saved.id === "string" && Array.isArray(saved.segments) &&
            saved.segments.length && saved.segments.every(segment => Array.isArray(segment) && segment.length &&
              segment.every(point => Number.isFinite(point?.lat) && Number.isFinite(point?.lng)))) {
          if (shouldSnap && !saved.matchedSegments) {
            const result = await matchStreetGeometry(outingGeometry(saved), undefined, progress);
            unmatched += result.unmatched;
            if (result.matched) saved.matchedSegments = result.data.geometries.map(geometry => geometry?.coordinates ?? null);
          }
          mergeOuting(saved);
        } else {
          const id = data.streetlogImport?.id || `folder-route:${entry.name}`;
          if (importedRoutes.some(route => route.id === id)) continue;
          const alreadySnapped = Boolean(data.streetlogImport?.snapped);
          const result = shouldSnap && !alreadySnapped
            ? await matchStreetGeometry(data, undefined, progress) : { data, unmatched: 0 };
          unmatched += result.unmatched;
          if (!plotImportedRoute({ id, name: entry.name, data: result.data,
            snapped: alreadySnapped || Boolean(result.matched) })) skipped++;
        }
      } catch {
        skipped++;
      } finally {
        folderProgress.value = ++done;
      }
    }
    for (const entry of files.photos) {
      try {
        const id = photoFileId(entry.name);
        if (photos.some(photo => photo.id === id)) continue;
        const gps = await window.exifr.gps(await entry.getFile());
        if (!Number.isFinite(gps?.latitude) || Math.abs(gps.latitude) > 90 ||
            !Number.isFinite(gps.longitude) || Math.abs(gps.longitude) > 180) throw new Error("Missing GPS");
        photos.push({ id, name: entry.name, point: L.latLng(gps.latitude, gps.longitude), getFile: entry.getFile });
      } catch {
        skipped++;
      } finally {
        folderProgress.value = ++done;
        folderStatus.textContent = `Reading library folder… ${done} of ${total} files processed`;
      }
    }
    refreshMap();
    const bounds = routeLayer.getBounds().extend(imports.getBounds());
    if (bounds.isValid() && !current) map.fitBounds(bounds, { maxZoom: 17, padding: [30, 30] });
    let summary = skipped ? ` Skipped ${skipped} unreadable files.` : "";
    if (unmatched) summary += " Unmatched sections use their original coordinates.";
    return summary;
  }

  async function connectFolder(handle) {
    folderBusy = true;
    folderProgress.removeAttribute("value");
    folderProgress.hidden = false;
    folderStatus.textContent = "Reading library folder…";
    try {
      if (!handle.server) {
        await handle.getDirectoryHandle("GeoJSON", { create: true });
        await handle.getDirectoryHandle("Photo", { create: true });
      }
      const summary = await loadFolder(await folderLibrary.list(handle));
      activeFolder = handle;
      if (!handle.server) rememberedFolder = handle;
      reconnectFolder.hidden = true;
      saveFolder.hidden = false;
      if (navigator.geolocation && window.isSecureContext) record.disabled = false;
      folderStatus.textContent = `Opened ${handle.name}.${summary}`;
      if (handle.server) folderStatus.textContent += " This folder will reopen on your next visit.";
      else {
        try {
          await folderLibrary.remember(handle);
        } catch {
          folderStatus.textContent += " This browser could not remember the folder.";
        }
      }
    } catch {
      folderStatus.textContent = "Could not open the library folder.";
    } finally {
      folderProgress.hidden = true;
      folderBusy = false;
    }
  }

  openFolder.addEventListener("click", async () => {
    if (folderBusy || current || matchingRecording) return;
    if (!window.showDirectoryPicker) {
      folderFiles.click();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker(folderPermission);
      await connectFolder(handle);
    } catch (error) {
      if (error.name !== "AbortError") {
        folderStatus.textContent = "This browser cannot remember the folder through the picker. Use the Mac folder path or import for this visit.";
        folderFiles.click();
      }
    }
  });

  reconnectFolder.addEventListener("click", async () => {
    if (folderBusy || current || matchingRecording || !rememberedFolder) return;
    try {
      if (await rememberedFolder.requestPermission(folderPermission) === "granted") {
        await connectFolder(rememberedFolder);
      }
    } catch {
      folderStatus.textContent = "Could not reconnect. Open the library folder again.";
    }
  });

  folderFiles.addEventListener("change", async () => {
    const files = [...folderFiles.files];
    folderFiles.value = "";
    if (!files.length || folderBusy) return;
    folderBusy = true;
    folderProgress.removeAttribute("value");
    folderProgress.hidden = false;
    folderStatus.textContent = "Reading library folder…";
    try {
      const summary = await loadFolder(folderLibrary.selectedFiles(files));
      folderStatus.textContent = `Folder imported for this visit only.${summary}`;
    } catch {
      folderStatus.textContent = "Could not load the library folder.";
    } finally {
      folderProgress.hidden = true;
      folderBusy = false;
    }
  });

  serverFolderForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (folderBusy || current || matchingRecording) return;
    folderBusy = true;
    try {
      const folder = await folderLibrary.serverPreference(serverFolderPath.value.trim());
      if (!folder?.name) throw new Error("Folder unavailable.");
      await connectFolder({ server: true, name: folder.name, key: folder.key });
      serverFolderPath.value = "";
    } catch (error) {
      folderStatus.textContent = error.message;
    } finally {
      folderBusy = false;
    }
  });

  async function reopenRememberedFolder() {
    try {
      const local = ["127.0.0.1", "localhost"].includes(window.location.hostname);
      const folder = local ? await folderLibrary.serverPreference() : null;
      if (folder) serverFolderForm.hidden = false;
      if (folder?.name) {
        await connectFolder({ server: true, name: folder.name, key: folder.key });
        return;
      }
    } catch {
      folderStatus.textContent = "The remembered Mac folder is unavailable. Enter its current path.";
      serverFolderForm.hidden = false;
    }
    if (!window.showDirectoryPicker) {
      if (!serverFolderForm.hidden) folderStatus.textContent = "Enter a Mac folder path to reopen it automatically. The picker imports for this visit only.";
      return;
    }
    try {
      rememberedFolder = await folderLibrary.remembered();
      if (!rememberedFolder) return;
      if (await rememberedFolder.queryPermission(folderPermission) === "granted") {
        await connectFolder(rememberedFolder);
      } else {
        reconnectFolder.hidden = false;
        folderStatus.textContent = `Reconnect ${rememberedFolder.name} to load its routes and photos.`;
      }
    } catch {
      folderStatus.textContent = "Open a library folder to load its routes and photos.";
    }
  }

  function writeFolderOuting(handle, outing) {
    const name = `outing-${encodeURIComponent(outing.id)}.geojson`;
    const data = JSON.stringify({
      type: "FeatureCollection", features: outingFeatures(outing), streetlogOuting: outing
    });
    const write = folderWrite.catch(() => {}).then(() => folderLibrary.write(handle, "routes", name, data, true));
    folderWrite = write;
    return write;
  }

  saveFolder.addEventListener("click", async () => {
    if (!activeFolder || folderBusy || current || matchingRecording || readingPhotos || importButton.disabled) {
      folderStatus.textContent = "Finish recording or importing before saving the folder.";
      return;
    }
    folderBusy = true;
    saveFolder.disabled = true;
    const handle = activeFolder;
    folderStatus.textContent = "Saving library folder…";
    try {
      for (const outing of outings) await writeFolderOuting(handle, outing);
      for (const route of importedRoutes) {
        if (route.id.startsWith("folder-route:")) continue;
        const name = `import-${encodeURIComponent(route.id)}.geojson`;
        await folderLibrary.write(handle, "routes", name, JSON.stringify({
          ...route.data, streetlogImport: { id: route.id, snapped: route.snapped }
        }));
      }
      for (const photo of photos) {
        const name = photo.id.startsWith("folder-photo:") ? photo.name : `streetlog-${photo.id}.jpg`;
        const file = photo.file ?? (photo.getFile ? await photo.getFile() : await (await fetch(photo.url)).blob());
        await folderLibrary.write(handle, "photos", name, file);
      }
      folderStatus.textContent = `Saved routes and photos to ${handle.name}.`;
    } catch {
      folderStatus.textContent = "Could not finish saving. Check folder access and available disk space, then retry.";
    } finally {
      folderBusy = false;
      saveFolder.disabled = false;
    }
  });

  if (["127.0.0.1", "localhost"].includes(window.location.hostname)) {
    restoreLibrary().then(reopenRememberedFolder);
  } else {
    reopenRememberedFolder();
  }


  function showLocation(point, center) {
    if (!marker) {
      marker = L.circleMarker(pointCoords(point), {
        radius: 7, color: "white", weight: 3, fillColor: "#1266a8", fillOpacity: 1
      }).addTo(map).bindTooltip("Your location");
    }
    marker.setLatLng(pointCoords(point)).bringToFront();
    if (center) map.setView(pointCoords(point), Math.max(map.getZoom(), 17));
  }

  function stop(message = "Ready to record") {
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    watch = null;
    current = null;
    byId("dot").classList.remove("active");
    record.innerHTML = '<span aria-hidden="true">●</span> Start recording';
    status.textContent = message;
    hint.textContent = defaultHint;
  }

  async function updateLiveMatch(preview) {
    if (!preview || preview.busy || current !== preview.outing) return;
    preview.busy = true;
    try {
      for (const [index, segment] of preview.outing.segments.entries()) {
        const state = preview.segments.get(index) ?? { offset: 0, paths: [] };
        while (segment.length - state.offset >= matchBatchSize && current === preview.outing) {
          const points = segment.slice(state.offset, state.offset + matchBatchSize);
          const result = await matchStreetGeometry({
            type: "LineString", coordinates: points.map(({ lat, lng }) => [lng, lat])
          }, preview.cache);
          if (current !== preview.outing) return;
          state.paths.push(...result.data.coordinates);
          state.offset += matchBatchSize - 1;
          preview.segments.set(index, state);
          if (result.matched) showRoutingAttribution();
          refreshMap();
        }
      }
    } finally {
      preview.busy = false;
    }
  }

  function outingGeometry(outing) {
    return {
      type: "GeometryCollection",
      geometries: outing.segments.map(segment => segment.length < 2 ? null : {
        type: "LineString", coordinates: segment.map(({ lat, lng }) => [lng, lat])
      })
    };
  }

  async function finishRecording(outing, preview) {
    if (!preview || !outing.segments.some(segment => segment.length > 1)) return;
    matchingRecording = true;
    record.disabled = true;
    status.textContent = "Matching recording to walking routes…";
    try {
      await preview?.pending;
      const result = await matchStreetGeometry(outingGeometry(outing), preview.cache);
      if (!result.matched) {
        status.textContent = "Street match unavailable. Original GPS trail saved.";
        return;
      }
      outing.matchedSegments = result.data.geometries.map(geometry => geometry?.coordinates ?? null);
      try {
        if (activeFolder) await writeFolderOuting(activeFolder, outing);
        else localStorage.setItem(storagePrefix + outing.id, JSON.stringify(outing));
      } catch {
        delete outing.matchedSegments;
        status.textContent = "Could not save the street match. Original GPS trail kept.";
        return;
      }
      refreshMap();
      status.textContent = result.unmatched
        ? "Recording snapped. Unmatched sections keep their GPS positions."
        : "Recording snapped to walking routes.";
    } catch {
      status.textContent = "Street match unavailable. Original GPS trail saved.";
    } finally {
      liveMatch = null;
      refreshMap();
      matchingRecording = false;
      record.disabled = false;
      }
  }

  function geoError(error) {
    return error.code === 1 ? "Location permission denied" : "Waiting for a GPS signal";
  }

  function addPosition(position) {
    if (!current) return;
    const { latitude: lat, longitude: lng, accuracy } = position.coords;
    if (accuracy > 35) {
      status.textContent = "Waiting for more accurate GPS";
      return;
    }

    status.textContent = "Recording";
    const point = { lat, lng, time: position.timestamp, accuracy };
    const segment = current.segments.at(-1);
    const previous = segment?.at(-1);
    const first = !previous;
    showLocation(point, first);
    const elapsed = previous ? (point.time - previous.time) / 1000 : 0;
    if (!first && elapsed <= 0) return;
    const moved = first ? 0 : distance(previous, point);
    const newSegment = first || breakTrail || elapsed > 45 || moved / Math.max(1, elapsed) > 45;
    if (!newSegment && moved < Math.max(5, accuracy / 2)) return;

    if (newSegment) current.segments.push([point]);
    else segment.push(point);

    try {
      if (!activeFolder) localStorage.setItem(storagePrefix + current.id, JSON.stringify(current));
    } catch {
      if (newSegment) current.segments.pop();
      else segment.pop();
      stop("Storage is full or unavailable");
      hint.textContent = "Recording stopped. Previously saved points can still be exported.";
      return;
    }
    if (first) outings.push(current);
    breakTrail = false;
    refreshMap();
    if (activeFolder && (first || point.time - lastFolderCheckpoint >= 15000)) {
      lastFolderCheckpoint = point.time;
      writeFolderOuting(activeFolder, current).catch(() => {
        folderStatus.textContent = "Could not save a recording checkpoint to the folder.";
      });
    }
    if (liveMatch && !liveMatch.busy) liveMatch.pending = updateLiveMatch(liveMatch);
  }

  record.addEventListener("click", () => {
    if (current) {
      const outing = current;
      stop();
      const handle = activeFolder;
      if (handle && outing.segments.length) {
        writeFolderOuting(handle, outing).then(() => {
          folderStatus.textContent = `Recording saved to ${handle.name}.`;
        }, () => {
          folderStatus.textContent = "Recording is still on the map. Use Save to folder to retry before leaving.";
        });
      }
      finishRecording(outing, liveMatch);
      return;
    }
    if (folderBusy) return;
    const outing = { id: crypto.randomUUID(), segments: [] };
    current = outing;
    liveMatch = snapStreets.checked ? { outing, cache: new Map(), segments: new Map(), busy: false } : null;
    breakTrail = false;
    byId("dot").classList.add("active");
    record.innerHTML = '<span aria-hidden="true">■</span> Stop recording';
    status.textContent = "Waiting for GPS";
    hint.textContent = "Keep this page open and your phone awake for continuous tracking.";
    watch = navigator.geolocation.watchPosition(position => {
      if (current === outing) addPosition(position);
    }, error => {
      if (current !== outing) return;
      if (error.code === 1) stop(geoError(error));
      else {
        breakTrail = true;
        status.textContent = geoError(error);
      }
    }, gpsOptions);
  });

  locate.addEventListener("click", () => {
    locate.disabled = true;
    locate.textContent = "Locating…";
    const resetLocate = () => {
      locate.disabled = false;
      locate.textContent = "⌖ My location";
    };
    navigator.geolocation.getCurrentPosition(position => {
      showLocation({ lat: position.coords.latitude, lng: position.coords.longitude }, true);
      resetLocate();
    }, error => {
      resetLocate();
      locate.textContent = error.code === 1 ? "Location blocked · Retry" : "Location unavailable · Retry";
    }, gpsOptions);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && current) breakTrail = true;
  });

  function outingFeatures(outing) {
    return outing.segments.map((segment, index) => {
      const coordinates = segment.map(point => [point.lng, point.lat]);
      const singlePoint = coordinates.length === 1;
      const matched = outing.matchedSegments?.[index];
      return {
        type: "Feature",
        properties: {
          outing: outing.id,
          timestamps: segment.map(point => new Date(point.time).toISOString()),
          accuracyMeters: segment.map(point => point.accuracy),
          ...(matched ? { originalCoordinates: coordinates } : {})
        },
        geometry: matched ? { type: "MultiLineString", coordinates: matched } : {
          type: singlePoint ? "Point" : "LineString",
          coordinates: singlePoint ? coordinates[0] : coordinates
        }
      };
    });
  }

  exportButton.addEventListener("click", () => {
    const features = outings.flatMap(outingFeatures);
    const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features })],
      { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "streetlog.geojson";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  if (!navigator.geolocation || !window.isSecureContext) {
    record.disabled = locate.disabled = true;
    status.textContent = "GPS unavailable";
    hint.textContent = "Open Streetlog in a browser over HTTPS or localhost.";
  }
}

init();
