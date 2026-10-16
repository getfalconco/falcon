import sys, zipfile, shutil, os
src, fixed_dir = sys.argv[1], sys.argv[2]
replace = {
    "___netlify-server-handler.mjs": os.path.join(fixed_dir, "___netlify-server-handler.mjs"),
    "apps/web/.next/required-server-files.json": os.path.join(fixed_dir, "apps/web/.next/required-server-files.json"),
}
backup = src + ".bak"
if not os.path.exists(backup):
    shutil.copy2(src, backup)
tmp = src + ".tmp"
with zipfile.ZipFile(backup) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for info in zin.infolist():
        data = zin.read(info.filename)
        if info.filename in replace:
            with open(replace[info.filename], "rb") as f:
                data = f.read()
            print("replaced", info.filename)
        zout.writestr(info, data)
os.replace(tmp, src)
with zipfile.ZipFile(src) as z:
    h = z.read("___netlify-server-handler.mjs").decode()
    print("still windows paths:", "\\var" in h)
