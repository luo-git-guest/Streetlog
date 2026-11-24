"use strict";

const folderLibrary = (() => {
  const key = "selected-directory";
  const folders = { routes: "GeoJSON", photos: "Photo" };

  async function accessPreference(mode, handle) {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("streetlog-folder", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("settings");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("settings", mode);
        const store = transaction.objectStore("settings");
        const request = mode === "readonly" ? store.get(key) : store.put(handle, key);
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }

  function isRoute(name) {
    return /\.(geojson|json)$/i.test(name);
  }

  function isPhoto(name) {
    return /\.jpe?g$/i.test(name);
  }

  function fileUrl(handle, type, name, replace = false) {
    return "/api/folder?" + new URLSearchParams({ folder: handle.key, kind: type, name, replace: replace ? "1" : "0" });
  }

  async function serverPreference(path) {
    const options = path === undefined ? undefined : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    };
    const response = await fetch("/api/folder", options);
    if (!response.headers.get("content-type")?.includes("application/json")) return null;
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Folder unavailable.");
    return result;
  }

  async function list(handle) {
    if (handle.server) {
      const result = await serverPreference();
      if (!result?.files || result.key !== handle.key) throw new Error("Folder unavailable.");
      return Object.fromEntries(Object.entries(result.files).map(([type, names]) => [
        type, names.map(name => ({
          name,
          getFile: async () => {
            const response = await fetch(fileUrl(handle, type, name));
            if (!response.ok) throw new Error("File unavailable.");
            return response.blob();
          }
        }))
      ]));
    }
    const files = { routes: [], photos: [] };
    for (const [type, name] of Object.entries(folders)) {
      let directory;
      try {
        directory = await handle.getDirectoryHandle(name);
      } catch (error) {
        if (error.name !== "NotFoundError") throw error;
        continue;
      }
      const accepts = type === "routes" ? isRoute : isPhoto;
      for await (const entry of directory.values()) {
        if (entry.kind === "file" && accepts(entry.name)) {
          files[type].push({ name: entry.name, getFile: () => entry.getFile() });
        }
      }
    }
    return files;
  }

  function selectedFiles(selection) {
    const files = { routes: [], photos: [] };
    for (const file of selection) {
      const parts = file.webkitRelativePath.split("/");
      if (parts.length !== 3) continue;
      const entry = { name: file.name, getFile: async () => file };
      if (parts[1] === folders.routes && isRoute(file.name)) files.routes.push(entry);
      if (parts[1] === folders.photos && isPhoto(file.name)) files.photos.push(entry);
    }
    return files;
  }

  async function write(handle, type, name, data, replace = false) {
    if (handle.server) {
      const response = await fetch(fileUrl(handle, type, name, replace), {
        method: "PUT", headers: { "X-Streetlog-Folder": "1" }, body: data
      });
      if (!response.ok) throw new Error("Could not write the folder file.");
      return;
    }
    const directory = await handle.getDirectoryHandle(folders[type], { create: true });
    if (!replace) {
      try {
        await directory.getFileHandle(name);
        return;
      } catch (error) {
        if (error.name !== "NotFoundError") throw error;
      }
    }
    const file = await directory.getFileHandle(name, { create: true });
    const stream = await file.createWritable();
    try {
      await stream.write(data);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
  }

  return {
    remember: handle => accessPreference("readwrite", handle),
    remembered: () => accessPreference("readonly"),
    list, selectedFiles, write, serverPreference
  };
})();
