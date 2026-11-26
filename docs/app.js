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

// Keep the straight-line approximation within five meters and limit point
// spacing so the matcher still gets observations near nearby streets.
function matchAnchorIndices(coordinates, includeEnd = true, limit = Infinity) {
  if (coordinates.length < 2) return coordinates.map((_, index) => index);

  const anchors = [0];
  let start = 0;
  for (let end = 1; end < coordinates.length; end++) {
    const [lng, lat] = coordinates[start];
    const metersPerLongitude = 111320 * Math.cos(lat * Math.PI / 180);
    const offsetMeters = point => [
      (((point[0] - lng + 540) % 360) - 180) * metersPerLongitude,
      (point[1] - lat) * 111320
    ];
    const [dx, dy] = offsetMeters(coordinates[end]);
    const lengthSquared = dx * dx + dy * dy;
    let preserve = !Number.isFinite(lengthSquared) || lengthSquared > 35 ** 2 || end - start > 32;
    if (!preserve && end - start >= 2) {
      const [cornerX, cornerY] = offsetMeters(coordinates[end - 1]);
      const [beforeX, beforeY] = offsetMeters(coordinates[end - 2]);
      const [ax, ay] = [cornerX - beforeX, cornerY - beforeY];
      const [bx, by] = [dx - cornerX, dy - cornerY];
      const incoming = Math.hypot(ax, ay);
      const outgoing = Math.hypot(bx, by);
      preserve = incoming >= 4.5 && outgoing >= 4.5 &&
        ax * bx + ay * by < incoming * outgoing * Math.SQRT1_2;
    }
    if (!preserve) {
      for (let index = start + 1; index < end; index++) {
        const [px, py] = offsetMeters(coordinates[index]);
        const projection = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0;
        if (!Number.isFinite(px + py) || Math.hypot(px - projection * dx, py - projection * dy) > 5) {
          preserve = true;
          break;
        }
      }
    }
    if (preserve) {
      start = Math.max(start + 1, end - 1);
      anchors.push(start);
      if (anchors.length === limit) return anchors;
      if (start < end) end = start;
    }
  }
  const last = coordinates.length - 1;
  if (includeEnd && anchors.at(-1) !== last) anchors.push(last);
  return anchors;
}

function streetMatchMark(value) {
  return value?.type === "Feature" ? value.properties ?? {} : value ?? {};
}

function lineMatchStatuses(geometry, mark = geometry) {
  const count = geometry.type === "LineString" ? 1 : geometry.coordinates.length;
  if (mark?.streetSnapped === true) return Array(count).fill(true);
  const statuses = mark?.streetSnappedParts;
  return Array.from({ length: count }, (_, index) => statuses?.[index] === true);
}

function countMatchBatches(geometry, anchorsFor, mark = streetMatchMark(geometry)) {
  if (mark.streetSnapped === true) return 0;
  switch (geometry?.type) {
    case "FeatureCollection":
      return geometry.features.reduce((sum, child) => sum + countMatchBatches(child, anchorsFor), 0);
    case "Feature":
      return countMatchBatches(geometry.geometry, anchorsFor, { ...geometry.geometry, ...mark });
    case "GeometryCollection":
      return geometry.geometries.reduce((sum, child) => sum + countMatchBatches(child, anchorsFor), 0);
    case "MultiLineString":
    case "LineString": {
      const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
      const statuses = lineMatchStatuses(geometry, mark);
      return lines.reduce((sum, line, index) => sum + (statuses[index] ? 0 :
        Math.max(0, Math.ceil((anchorsFor(line).length - 1) / (matchBatchSize - 1)))), 0);
    }
    default:
      return 0;
  }
}

function containsSnappedRoute(data) {
  const mark = streetMatchMark(data);
  if (mark.streetSnapped === true || (Array.isArray(mark.streetSnappedParts) && mark.streetSnappedParts.includes(true))) return true;
  if (data?.type === "Feature") return containsSnappedRoute(data.geometry);
  if (data?.type === "FeatureCollection") return data.features.some(containsSnappedRoute);
  if (data?.type === "GeometryCollection") return data.geometries.some(containsSnappedRoute);
  return false;
}

async function matchStreetGeometry(data, cache, onProgress) {
  const anchorsByLine = new WeakMap();
  function anchorsFor(coordinates) {
    if (!anchorsByLine.has(coordinates)) anchorsByLine.set(coordinates, matchAnchorIndices(coordinates));
    return anchorsByLine.get(coordinates);
  }
  const total = onProgress ? countMatchBatches(data, anchorsFor) : 0;
  if (total) onProgress(0, total);
  let matched = 0;
  let unmatched = 0;

  async function matchLine(coordinates) {
    const lines = [];
    const anchors = anchorsFor(coordinates);
    // Overlap chunks by one anchor so adjacent requests share an endpoint.
    for (let start = 0; start < anchors.length - 1; start += matchBatchSize - 1) {
      const batch = anchors.slice(start, start + matchBatchSize);
      const points = batch.map(index => coordinates[index]);
      try {
        const positions = points.map(([lng, lat]) => {
          if (!Number.isFinite(lng) || !Number.isFinite(lat) ||
              Math.abs(lng) > 180 || Math.abs(lat) > 90) throw new Error("Invalid position");
          return [lng.toFixed(6), lat.toFixed(6)].join(",");
        }).join(";");
        const cached = cache?.get(positions);
        if (cached) {
          lines.push({ coordinates: cached, snapped: true });
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
        lines.push({ coordinates: geometry.coordinates, snapped: true });
        matched++;
      } catch {
        lines.push({ coordinates: coordinates.slice(batch[0], batch.at(-1) + 1), snapped: false });
        unmatched++;
      } finally {
        if (total) onProgress(matched + unmatched, total);
      }
    }
    return lines;
  }

  async function visit(value, mark = streetMatchMark(value)) {
    if (!value || mark.streetSnapped === true) return value;
    switch (value.type) {
      case "FeatureCollection": {
        const features = [];
        for (const feature of value.features) features.push(await visit(feature));
        return { ...value, features };
      }
      case "Feature": {
        const geometry = await visit(value.geometry, { ...value.geometry, ...mark });
        if (geometry === value.geometry || geometry?.streetSnapped === undefined) return { ...value, geometry };
        const { streetSnapped, streetSnappedParts, ...geoJSON } = geometry;
        return {
          ...value, geometry: geoJSON, properties: {
            ...value.properties, streetSnapped, streetSnappedParts,
            ...(streetSnappedParts.some(Boolean) && value.geometry.type === "LineString" &&
              !value.properties?.originalCoordinates ? { originalCoordinates: value.geometry.coordinates } : {})
          }
        };
      }
      case "GeometryCollection": {
        const geometries = [];
        for (const geometry of value.geometries) geometries.push(await visit(geometry));
        return { ...value, geometries };
      }
      case "LineString":
      case "MultiLineString": {
        const lines = value.type === "LineString" ? [value.coordinates] : value.coordinates;
        const statuses = lineMatchStatuses(value, mark);
        if (statuses.length && statuses.every(Boolean)) return value;
        const parts = [];
        for (const [index, line] of lines.entries()) {
          if (statuses[index] || line.length < 2) parts.push({ coordinates: line, snapped: statuses[index] });
          else parts.push(...await matchLine(line));
        }
        const streetSnappedParts = parts.map(part => part.snapped);
        return { type: "MultiLineString", coordinates: parts.map(part => part.coordinates),
          streetSnapped: parts.length > 0 && streetSnappedParts.every(Boolean), streetSnappedParts };
      }
      default:
        return value;
    }
  }

  return { data: await visit(data), matched, unmatched };
}

function routePaths(geometry) {
  if (!geometry) return [];
  const { type, coordinates } = geometry;
  if (type === "GeometryCollection") return geometry.geometries.flatMap(routePaths);
  const validPoint = point => Array.isArray(point) &&
    Number.isFinite(point[0]) && Math.abs(point[0]) <= 180 &&
    Number.isFinite(point[1]) && Math.abs(point[1]) <= 90;
  const paths = {
    Point: () => [[coordinates]],
    MultiPoint: () => Array.isArray(coordinates) ? coordinates.map(point => [point]) : [],
    LineString: () => [coordinates],
    MultiLineString: () => Array.isArray(coordinates) ? coordinates : []
  }[type]?.() ?? [];
  return paths.filter(path => Array.isArray(path) && path.length && path.every(validPoint));
}

function importedOutingGroups(route) {
  const asFeatures = data => data.type === "FeatureCollection" ? data.features :
    [data.type === "Feature" ? data : { type: "Feature", geometry: data }];
  const original = asFeatures(route.sourceData ?? route.data);
  const groups = new Map();
  asFeatures(route.data).forEach((feature, index) => {
    const paths = routePaths(feature?.geometry);
    if (!paths.length) return;
    const properties = feature.properties ?? {};
    const sourceID = typeof properties.outing === "string" ? properties.outing : "";
    if (!groups.has(sourceID)) {
      groups.set(sourceID, {
        key: JSON.stringify([route.id, sourceID]), routeID: route.id, sourceID,
        name: route.name || properties.name || "Imported route",
        segments: [], matchedSegments: [], matchStatuses: [], features: [], snapped: route.snapped
      });
    }
    const group = groups.get(sourceID);
    group.features.push(feature);
    const source = original[index]?.geometry;
    const embedded = routePaths({ type: "LineString", coordinates: properties.originalCoordinates });
    const sourceLine = source?.type === "LineString" ? routePaths(source) : [];
    const originalPath = embedded[0] ?? sourceLine[0];
    const preserveOriginal = originalPath?.length > 1 && paths.every(path => path.length > 1);
    const rawPaths = preserveOriginal ? [originalPath] : paths;
    rawPaths.forEach((path, pathIndex) => {
      const metadata = pathIndex === 0 && rawPaths.length === 1;
      group.segments.push(path.map(([lng, lat], pointIndex) => {
        const timestamp = metadata ? properties.timestamps?.[pointIndex] : null;
        const time = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
        const accuracy = metadata ? properties.accuracyMeters?.[pointIndex] : null;
        return { lng, lat, time: Number.isFinite(time) ? time : null,
          accuracy: Number.isFinite(accuracy) ? accuracy : null };
      }));
      const moved = preserveOriginal && (paths.length > 1 || JSON.stringify(paths[0]) !== JSON.stringify(path));
      group.matchedSegments.push(moved ? paths : null);
      const mark = { ...feature.geometry, ...properties };
      const statuses = paths.map((_, index) => mark.streetSnapped === true || mark.streetSnappedParts?.[index] === true);
      group.matchStatuses.push(preserveOriginal ? statuses : [statuses[pathIndex]]);
    });
    if (containsSnappedRoute(feature)) group.snapped = true;
  });
  return [...groups.values()].map((group, index) => ({
    ...group, name: groups.size > 1 ? `${group.name} · Outing ${index + 1}` : group.name
  }));
}

async function importedOutingID(group) {
  if (/^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|import-[a-f0-9]{64})$/i.test(group.sourceID)) {
    return group.sourceID.toLowerCase();
  }
  const key = JSON.stringify([group.sourceID, group.segments.map(segment =>
    segment.map(({ lng, lat }) => [lng, lat]))]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return "import-" + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
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
  const importedGroups = new Map();
  const photos = [];
  const photoLayers = L.featureGroup().addTo(map);
  const selectionLayers = L.featureGroup().addTo(map);
  const outingSelectionLayers = L.featureGroup().addTo(map);
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
        radius: importedStyle.weight / 2, stroke: false,
        fillColor: importedStyle.color, fillOpacity: importedStyle.opacity
      })
    });
    const bounds = layer.getBounds();
    if (!bounds.isValid()) return null;
    const groups = importedOutingGroups(route);
    imports.addLayer(layer);
    importLayers.set(route.id, layer);
    collectPaths(layer);
    importedRoutes.push(route);
    for (const group of groups) importedGroups.set(group.key, group);
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
    importStatus.textContent = `Reading ${file.name}…`;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.type !== "string") throw new Error("Missing GeoJSON type");
      const result = shouldSnap ? await matchStreetGeometry(data, undefined, (done, total) => {
        importProgress.max = total;
        importProgress.value = done;
        importStatus.textContent = `Matching streets · ${file.name} · ${done} of ${total} sections processed`;
      }) : { data };
      const bounds = plotImportedRoute({
        id: crypto.randomUUID(), name: file.name, data: result.data, sourceData: result.matched ? data : undefined, snapped: containsSnappedRoute(result.data)
      });
      if (!bounds) {
        importStatus.textContent = "This file has no map features to display.";
        return;
      }
      showPhotoSections();
      renderOutingPicker();
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
  const browserOutings = new Set();
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
    const saved = Object.keys(localStorage)
      .filter(key => key.startsWith(storagePrefix))
      .map(key => JSON.parse(localStorage.getItem(key)))
      .filter(outing => outing?.segments?.length);
    for (const outing of saved) browserOutings.add(outing.id);
    return saved;
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
        pointToLayer: (_feature, point) => L.circleMarker(point, {
          radius: style.weight / 2, stroke: false, fillColor: style.color, fillOpacity: 1, interactive: false
        })
      }).addTo(selectionLayers).bringToFront();
    }
    if (center && selectionLayers.getBounds().isValid()) {
      map.fitBounds(selectionLayers.getBounds(), { maxZoom: 17, padding: [35, 35] });
    }
  }

  const checkedRecorded = new Set();
  const checkedImported = new Set();
  const outingPicker = byId("outing-picker");
  const recordedChoices = byId("recorded-choices");
  const importedChoices = byId("imported-choices");
  const mergeOutings = byId("merge-outings");
  const clearOutings = byId("clear-outings");
  const deleteRecording = byId("delete-recording");
  const outingStatus = byId("outing-status");
  let chooserSignature = "";
  let mergingOutings = false;
  let deletingRecording = false;

  function outingName(outing, index) {
    const time = outing.segments[0]?.[0]?.time;
    return outing.name || (Number.isFinite(time) ? new Date(time).toLocaleString() : `Outing ${index + 1}`);
  }

  function renderOutingPicker() {
    byId("imported-outings").textContent = importedGroups.size;
    outingPicker.hidden = outings.length === 0 && importedGroups.size === 0;
    const recorded = outings.map((outing, index) => [outing.id, outingName(outing, index)]);
    const imported = [...importedGroups.values()].map(group => [group.key, group.name]);
    const signature = JSON.stringify([recorded, imported]);
    if (signature !== chooserSignature) {
      chooserSignature = signature;
      for (const [container, entries, selected] of [
        [recordedChoices, recorded, checkedRecorded], [importedChoices, imported, checkedImported]
      ]) {
        const keys = new Set(entries.map(([key]) => key));
        for (const key of selected) if (!keys.has(key)) selected.delete(key);
        container.replaceChildren();
        for (const [key, name] of entries) {
          const label = document.createElement("label");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.value = key;
          checkbox.checked = selected.has(key);
          label.append(checkbox, document.createTextNode(name));
          container.append(label);
        }
        if (!entries.length) container.textContent = "No outings";
      }
    }
    const count = checkedRecorded.size;
    exportButton.disabled = outings.length === 0;
    exportButton.textContent = count ? `Export selected (${count})` : "Export all GeoJSON";
    mergeOutings.disabled = checkedImported.size === 0 || mergingOutings;
    clearOutings.disabled = checkedImported.size + count === 0;
    deleteRecording.disabled = count !== 1 || deletingRecording;
  }

  function highlightOutings(center = false) {
    outingSelectionLayers.clearLayers();
    const features = [
      ...outings.filter(outing => checkedRecorded.has(outing.id)).flatMap(outingFeatures),
      ...[...checkedImported].flatMap(key => importedGroups.get(key)?.features ?? [])
    ];
    if (features.length === 0) return;
    const style = { color: "#2155cf", weight: 8, interactive: false };
    L.geoJSON({ type: "FeatureCollection", features }, {
      style,
      pointToLayer: (_feature, point) => L.circleMarker(point, {
        radius: style.weight / 2, stroke: false, fillColor: style.color, fillOpacity: 1, interactive: false
      })
    }).addTo(outingSelectionLayers).bringToFront();
    const bounds = outingSelectionLayers.getBounds();
    if (center && bounds.isValid()) map.fitBounds(bounds, { maxZoom: 17, padding: [35, 35] });
  }

  for (const [container, selection] of [[recordedChoices, checkedRecorded], [importedChoices, checkedImported]]) {
    container.addEventListener("change", event => {
      const checkbox = event.target;
      if (checkbox.checked) selection.add(checkbox.value);
      else selection.delete(checkbox.value);
      renderOutingPicker();
      highlightOutings(true);
    });
  }

  clearOutings.addEventListener("click", () => {
    checkedRecorded.clear();
    checkedImported.clear();
    chooserSignature = "";
    renderOutingPicker();
    highlightOutings();
    outingStatus.textContent = "";
  });

  function refreshMap() {
    routeLayer?.remove();
    routeLayer = L.featureGroup().addTo(map);
    let meters = 0;
    for (const outing of outings) {
      if (outing.snapped || (outing.matchedSegments && outing.snapped !== false)) showRoutingAttribution();
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
    renderOutingPicker();
    showPhotoSections();
    highlightServerItem();
    highlightOutings();
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
    if (readingPhotos || importButton.disabled || matchingRecording || deletingRecording) {
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
    if (!selected || serverBusy || deletingRecording) return;
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
      await deleteServerCopy(collection, id);
      if (collection === "outings") {
        outings = outings.filter(outing => outing.id !== id);
      } else if (collection === "imports") {
        const index = importedRoutes.findIndex(route => route.id === id);
        if (index >= 0) importedRoutes.splice(index, 1);
        const layer = importLayers.get(id);
        if (layer) imports.removeLayer(layer);
        importLayers.delete(id);
        for (const [key, group] of importedGroups) {
          if (group.routeID === id) importedGroups.delete(key);
        }
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

  async function deleteServerCopy(collection, id) {
    const response = await fetch("/api/library", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection, id })
    });
    if (!response.ok) throw new Error((await response.json()).error);
    savedItems[collection].delete(id);
  }

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
  const folderOutingFiles = new Map();
  const folderImportFiles = new Map();
  const readOnlyOutings = new Set();

  function rememberFolderOuting(id, handle, name) {
    if (!handle) {
      readOnlyOutings.add(id);
      return;
    }
    readOnlyOutings.delete(id);
    const copies = folderOutingFiles.get(id) ?? [];
    if (!copies.some(copy => copy.handle === handle && copy.name === name)) copies.push({ handle, name });
    folderOutingFiles.set(id, copies);
  }

  function saveBrowserOuting(outing) {
    localStorage.setItem(storagePrefix + outing.id, JSON.stringify(outing));
    browserOutings.add(outing.id);
  }

  function mergeOuting(outing) {
    const index = outings.findIndex(existing => existing.id === outing.id);
    if (index < 0) {
      outings.push(outing);
      return;
    }
    const existing = outings[index];
    const count = item => item.segments.reduce((sum, segment) => sum + segment.length, 0);
    if (existing !== current && (count(outing) > count(existing) ||
        (count(outing) === count(existing) && outing.matchedSegments &&
          (!existing.matchedSegments || (outing.matchStatuses && !existing.matchStatuses))))) {
      outings[index] = outing;
    }
  }

  function photoFileId(name) {
    const stored = /^streetlog-([a-f0-9-]{36})\.(?:jpg|jpeg)$/i.exec(name);
    return stored ? stored[1] : `folder-photo:${name}`;
  }

  async function loadFolder(files, handle = null) {
    let skipped = 0;
    let unmatched = 0;
    let done = 0;
    const total = files.routes.length + files.photos.length;
    const shouldSnap = snapStreets.checked;
    folderProgress.max = Math.max(1, total);
    folderProgress.value = 0;
    for (const entry of files.routes) {
      const fileLabel = `File ${done + 1} of ${total} · ${entry.name}`;
      folderStatus.textContent = `Reading route · ${fileLabel}`;
      const progress = (matched, batches) => {
        folderProgress.value = done + matched / batches;
        folderStatus.textContent = `Matching streets · ${fileLabel} · ${matched} of ${batches} sections processed`;
      };
      try {
        const data = JSON.parse(await (await entry.getFile()).text());
        const saved = data.streetlogOuting;
        if (saved && typeof saved.id === "string" && Array.isArray(saved.segments) &&
            saved.segments.length && saved.segments.every(segment => Array.isArray(segment) && segment.length &&
              segment.every(point => Number.isFinite(point?.lat) && Number.isFinite(point?.lng)))) {
          if (shouldSnap) {
            const result = await matchStreetGeometry(outingGeometry(saved, true), undefined, progress);
            unmatched += result.unmatched;
            if (result.matched) applyStreetMatch(saved, result.data);
          }
          mergeOuting(saved);
          rememberFolderOuting(saved.id, handle, entry.name);
        } else {
          const id = data.streetlogImport?.id || `folder-route:${entry.name}`;
          if (importedRoutes.some(route => route.id === id)) continue;
          const result = shouldSnap
            ? await matchStreetGeometry(data, undefined, progress) : { data, unmatched: 0 };
          unmatched += result.unmatched;
          if (!plotImportedRoute({ id, name: entry.name, data: result.data,
            sourceData: data.streetlogImport?.sourceData ?? (result.matched ? data : undefined),
            snapped: containsSnappedRoute(result.data) })) skipped++;
          else if (handle) folderImportFiles.set(id, { handle, name: entry.name, updated: Boolean(result.matched) });
        }
      } catch {
        skipped++;
      } finally {
        folderProgress.value = ++done;
      }
    }
    for (const entry of files.photos) {
      folderStatus.textContent = `Reading photo · File ${done + 1} of ${total} · ${entry.name}`;
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
      const summary = await loadFolder(await folderLibrary.list(handle), handle);
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
    if (folderBusy || mergingOutings || deletingRecording || current || matchingRecording) return;
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
    if (folderBusy || mergingOutings || deletingRecording || current || matchingRecording || !rememberedFolder) return;
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
    if (folderBusy || mergingOutings || deletingRecording || current || matchingRecording) return;
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
    const write = folderWrite.catch(() => {}).then(async () => {
      await folderLibrary.write(handle, "routes", name, data, true);
      rememberFolderOuting(outing.id, handle, name);
    });
    folderWrite = write;
    return write;
  }

  deleteRecording.addEventListener("click", async () => {
    if (checkedRecorded.size !== 1 || deletingRecording) return;
    if (current || matchingRecording || folderBusy || mergingOutings || serverBusy) {
      outingStatus.textContent = "Finish recording or saving before deleting an outing.";
      return;
    }
    const [id] = checkedRecorded;
    const index = outings.findIndex(outing => outing.id === id);
    if (index < 0) return;
    if (readOnlyOutings.has(id)) {
      outingStatus.textContent = "This recording was opened from a read-only folder. Reopen that folder with write access, or remove its file in Files or Finder.";
      return;
    }
    const name = outingName(outings[index], index);
    if (!window.confirm(`Delete this recording and its saved Streetlog copies?\n${name}`)) return;
    deletingRecording = true;
    outingStatus.textContent = "Deleting recording…";
    renderOutingPicker();
    try {
      await folderWrite.catch(() => {});
      for (const copy of folderOutingFiles.get(id) ?? []) {
        await folderLibrary.removeOuting(copy.handle, copy.name, id);
      }
      if (savedItems.outings.has(id)) await deleteServerCopy("outings", id);
      try {
        localStorage.removeItem(storagePrefix + id);
      } catch (error) {
        if (browserOutings.has(id)) throw error;
      }
      browserOutings.delete(id);
      folderOutingFiles.delete(id);
      outings = outings.filter(outing => outing.id !== id);
      checkedRecorded.delete(id);
      renderServerItems();
      refreshMap();
      outingStatus.textContent = "Recording deleted.";
    } catch (error) {
      outingStatus.textContent = `Could not finish deleting. ${error.message} You can retry.`;
    } finally {
      deletingRecording = false;
      renderOutingPicker();
    }
  });

  mergeOutings.addEventListener("click", async () => {
    if (mergingOutings || deletingRecording || checkedImported.size === 0) return;
    if (current || matchingRecording || folderBusy || importButton.disabled) {
      outingStatus.textContent = "Finish recording or importing before adding outings.";
      return;
    }
    mergingOutings = true;
    renderOutingPicker();
    outingStatus.textContent = "Adding selected outings to your recorded library…";
    const handle = activeFolder;
    const selection = [...checkedImported].map(key => importedGroups.get(key)).filter(Boolean);
    let added = 0;
    let existing = 0;
    let failed = 0;
    for (const group of selection) {
      try {
        const id = await importedOutingID(group);
        if (outings.some(outing => outing.id.toLowerCase() === id)) {
          existing++;
        } else {
          const outing = { id, name: group.name, segments: group.segments };
          if (group.matchedSegments.some(Boolean)) outing.matchedSegments = group.matchedSegments;
          outing.matchStatuses = group.matchStatuses;
          outing.snapped = Boolean(group.snapped);
          if (handle) await writeFolderOuting(handle, outing);
          else saveBrowserOuting(outing);
          outings.push(outing);
          added++;
        }
        checkedRecorded.add(outings.find(outing => outing.id.toLowerCase() === id).id);
        checkedImported.delete(group.key);
      } catch {
        failed++;
      }
    }
    mergingOutings = false;
    chooserSignature = "";
    refreshMap();
    highlightOutings(true);
    outingStatus.textContent = `Added ${added} to recorded outings.` +
      (existing ? ` ${existing} already in the library.` : "") +
      (failed ? ` Could not save ${failed}. Check the folder or browser storage and retry.` : "");
  });

  saveFolder.addEventListener("click", async () => {
    if (!activeFolder || folderBusy || mergingOutings || deletingRecording || current || matchingRecording || readingPhotos || importButton.disabled) {
      folderStatus.textContent = "Finish recording or importing before saving the folder.";
      return;
    }
    folderBusy = true;
    saveFolder.disabled = true;
    const handle = activeFolder;
    const updated = importedRoutes.filter(route => {
      const origin = folderImportFiles.get(route.id);
      return origin?.handle === handle && origin.updated;
    }).length;
    const saveMatches = updated === 0 || window.confirm(
      `Update the geometry and snap status in ${updated} existing GeoJSON files? Original GPS coordinates will be kept in the files.`
    );
    folderStatus.textContent = "Saving library folder…";
    try {
      for (const outing of outings) await writeFolderOuting(handle, outing);
      for (const route of importedRoutes) {
        const origin = folderImportFiles.get(route.id);
        const inCurrentFolder = origin?.handle === handle;
        if (inCurrentFolder && (!origin.updated || !saveMatches)) continue;
        if (!inCurrentFolder && route.id.startsWith("folder-route:")) continue;
        const name = inCurrentFolder ? origin.name : `import-${encodeURIComponent(route.id)}.geojson`;
        const data = JSON.stringify({
          ...route.data, streetlogImport: { id: route.id, snapped: route.snapped, sourceData: route.sourceData }
        });
        await folderLibrary.write(handle, "routes", name, data, inCurrentFolder);
        folderImportFiles.set(route.id, { handle, name, updated: false });
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

  async function loadPublishedRoutes() {
    const publishedStatus = byId("published-status");
    const base = new URL(".", document.baseURI);
    let folder;
    let files;
    try {
      const config = await fetch(new URL("site.json", base), { cache: "no-cache" });
      if (config.status === 404) return;
      if (!config.ok) throw new Error("Site configuration unavailable.");
      const { GeoJSON_folder: path } = await config.json();
      if (typeof path !== "string" || !path.trim()) throw new Error("Set GeoJSON_folder in site.json.");
      folder = new URL(path.trim().replace(/\/?$/, "/"), base);
      if (folder.origin !== base.origin || !folder.pathname.startsWith(base.pathname) ||
          folder.search || folder.hash) throw new Error("GeoJSON_folder must be inside the published site.");
      const response = await fetch(new URL("index.json", folder), { cache: "no-cache" });
      if (!response.ok) throw new Error("Could not read the GeoJSON folder’s index.json.");
      ({ files } = await response.json());
      if (!Array.isArray(files) || !files.every(name =>
        typeof name === "string" && /^[^/\\]+\.geojson$/i.test(name))) {
        throw new Error("index.json must list GeoJSON filenames in its files array.");
      }
    } catch (error) {
      publishedStatus.textContent = error.message;
      return;
    }

    const bounds = L.latLngBounds([]);
    let loaded = 0;
    let failed = 0;
    for (const name of new Set(files)) {
      const url = new URL(encodeURIComponent(name), folder);
      const id = `published:${url.pathname}`;
      if (importLayers.has(id)) continue;
      publishedStatus.textContent = `Loading published route · ${name}`;
      try {
        const response = await fetch(url, { cache: "no-cache" });
        if (!response.ok) throw new Error("Route unavailable.");
        const data = await response.json();
        const plotted = plotImportedRoute({ id, name, data, snapped: containsSnappedRoute(data) });
        if (!plotted) throw new Error("No map geometry found.");
        bounds.extend(plotted);
        loaded++;
      } catch {
        failed++;
      }
    }
    if (loaded) refreshMap();
    if (bounds.isValid() && !current && checkedRecorded.size + checkedImported.size === 0) {
      map.fitBounds(bounds, { maxZoom: 17, padding: [30, 30] });
    }
    publishedStatus.textContent = loaded ? `Loaded ${loaded} published route files.` : "";
    if (failed) publishedStatus.textContent += ` Could not load ${failed} published route files.`;
  }

  if (["127.0.0.1", "localhost"].includes(window.location.hostname)) {
    restoreLibrary().then(loadPublishedRoutes).then(reopenRememberedFolder);
  } else {
    loadPublishedRoutes();
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
          const coordinates = segment.slice(state.offset).map(({ lat, lng }) => [lng, lat]);
          const anchors = matchAnchorIndices(coordinates, false, matchBatchSize);
          if (anchors.length < matchBatchSize) break;
          const end = anchors.at(-1);
          const result = await matchStreetGeometry({
            type: "LineString", coordinates: coordinates.slice(0, end + 1)
          }, preview.cache);
          if (current !== preview.outing) return;
          state.paths.push(...result.data.coordinates);
          state.offset += end;
          preview.segments.set(index, state);
          if (result.matched) showRoutingAttribution();
          refreshMap();
        }
      }
    } finally {
      preview.busy = false;
    }
  }

  function outingGeometry(outing, useSaved = false) {
    return {
      type: "GeometryCollection",
      geometries: outing.segments.map((segment, index) => {
        if (segment.length < 2) return null;
        const statuses = useSaved ? outing.matchStatuses?.[index] : null;
        const matched = statuses && outing.matchedSegments?.[index];
        const streetSnapped = Boolean(statuses?.length && statuses.every(Boolean));
        if (matched) {
          return { type: "MultiLineString", coordinates: matched, streetSnapped, streetSnappedParts: statuses };
        }
        return { type: "LineString", coordinates: segment.map(({ lat, lng }) => [lng, lat]), streetSnapped };
      })
    };
  }

  function applyStreetMatch(outing, geometry) {
    outing.matchedSegments = geometry.geometries.map(section =>
      section?.type === "MultiLineString" ? section.coordinates :
        section?.streetSnapped ? [section.coordinates] : null);
    outing.matchStatuses = geometry.geometries.map(section =>
      section?.streetSnappedParts ?? (section?.streetSnapped ? [true] : null));
    outing.snapped = containsSnappedRoute(geometry);
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
      applyStreetMatch(outing, result.data);
      try {
        if (activeFolder) await writeFolderOuting(activeFolder, outing);
        else saveBrowserOuting(outing);
      } catch {
        delete outing.matchedSegments;
        delete outing.matchStatuses;
        delete outing.snapped;
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
      if (!activeFolder) saveBrowserOuting(current);
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
    if (folderBusy || mergingOutings || deletingRecording) return;
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
      const statuses = outing.matchStatuses?.[index] ?? (matched ? matched.map(() => false) : [false]);
      return {
        type: "Feature",
        properties: {
          outing: outing.id,
          streetSnapped: !singlePoint && statuses.every(Boolean),
          ...(matched ? { streetSnappedParts: statuses } : {}),
          timestamps: segment.map(point => Number.isFinite(point.time) && Number.isFinite(new Date(point.time).getTime())
            ? new Date(point.time).toISOString() : null),
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
    const selected = checkedRecorded.size ? outings.filter(outing => checkedRecorded.has(outing.id)) : outings;
    const features = selected.flatMap(outingFeatures);
    const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features })],
      { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = checkedRecorded.size ? "streetlog-selected.geojson" : "streetlog.geojson";
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
