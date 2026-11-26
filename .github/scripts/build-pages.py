"""Copy the public website and generate its published GeoJSON index."""
import argparse
import json
import shutil
from pathlib import Path


def build_pages(repository: Path, output: Path) -> None:
    published_source = repository / "docs"
    config_file = repository / "site.json"
    config = json.loads(config_file.read_text(encoding="utf-8"))
    folder_value = config.get("GeoJSON_folder")
    if not isinstance(folder_value, str) or not folder_value.strip():
        raise ValueError("GeoJSON_folder must name a folder inside docs/.")
    relative_folder = Path(folder_value.strip())
    if (relative_folder.is_absolute() or ".." in relative_folder.parts
            or any(character in folder_value for character in "\\:?#%")):
        raise ValueError("GeoJSON_folder must be a relative path inside docs/.")
    if any(path.is_symlink() for path in published_source.rglob("*")):
        raise ValueError("GitHub Pages does not publish symbolic links.")

    shutil.copytree(published_source, output)
    shutil.copyfile(config_file, output / "site.json")
    folder = output / relative_folder
    folder.mkdir(parents=True, exist_ok=True)
    files = sorted(
        (file.name for file in folder.iterdir() if file.is_file() and file.suffix.lower() == ".geojson"),
        key=lambda name: (name.casefold(), name),
    )
    manifest = json.dumps({"files": files}, ensure_ascii=False, indent=2) + "\n"
    (folder / "index.json").write_text(manifest, encoding="utf-8")
    print(f"Indexed {len(files)} GeoJSON files in docs/{relative_folder}/.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build_pages(Path(__file__).resolve().parents[2], args.output)
