"""Rewrites absolute Windows symlink targets in a function zip to relative posix ones."""
import os, sys, zipfile, posixpath, re

zip_path, repo_prefix = sys.argv[1], sys.argv[2].replace("\\", "/").rstrip("/") + "/"
tmp = zip_path + ".tmp"
fixed = 0
with zipfile.ZipFile(zip_path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    names = set(zin.namelist())
    for info in zin.infolist():
        data = zin.read(info.filename)
        mode = info.external_attr >> 16
        if (mode & 0o170000) == 0o120000:
            target = data.decode().replace("\\", "/")
            if target.lower().startswith(repo_prefix.lower()):
                inner = target[len(repo_prefix):]
                rel = posixpath.relpath(inner, posixpath.dirname(info.filename))
                if not any(n.startswith(inner.rstrip("/") + "/") for n in names):
                    print("WARNING target missing in zip:", inner)
                data = rel.encode()
                info.external_attr = (0o120777 << 16)
                info.create_system = 3
                fixed += 1
                print(info.filename, "->", rel)
        zout.writestr(info, data)
os.replace(tmp, zip_path)
print("fixed", fixed)
