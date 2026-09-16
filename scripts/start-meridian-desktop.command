#!/bin/bash
# Meridian / Falcon masaüstü uygulamasını başlatır (geliştirme modu)

PROJECT="/Users/umutuslu/Desktop/Projects/meridian website"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Cursor/IDE sometimes sets this; it breaks Electron's ipcMain API.
unset ELECTRON_RUN_AS_NODE

cd "$PROJECT" || {
  echo "Proje klasoru bulunamadi: $PROJECT"
  read -r -p "Kapatmak icin Enter..."
  exit 1
}

echo "Meridian desktop baslatiliyor..."
echo "(Bu pencereyi kapatirsaniz uygulama da kapanir.)"
echo ""

exec env -u ELECTRON_RUN_AS_NODE pnpm dev:desktop
