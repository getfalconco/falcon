/**
 * Messages for one area of the app, in every language. Keys are prefixed by
 * the area so they never collide with another file. English is the source;
 * the other tables are Partial and fall back to English per key. Same rules
 * as messages/en.ts: `{name}` placeholders kept in every language, and no
 * em dash or en dash anywhere (shared/copy-rules.ts).
 *
 * The shell: the home screen's tab strip and card handles, the update card,
 * and the generic components under components/ui.
 */
export const en = {
  "shell.tabs.label": "Home views",
  "shell.tabs.dragHint": "{label}: drag to reorder",

  "shell.resize.left": "Resize the {card} card from the left",
  "shell.resize.right": "Resize the {card} card from the right",
  "shell.resize.top": "Resize the {card} card from the top",
  "shell.resize.bottom": "Resize the {card} card from the bottom",
  "shell.resize.topLeft": "Resize the {card} card from the top left",
  "shell.resize.topRight": "Resize the {card} card from the top right",
  "shell.resize.bottomLeft": "Resize the {card} card from the bottom left",
  "shell.resize.corner": "Resize the {card} card",
  "shell.resize.hint": "Drag to resize",
  "shell.resize.seam": "Resize the cards on both sides",
  "shell.resize.seamHint": "Drag to resize both cards",

  "shell.update.ready": "Update available",
  "shell.update.restart": "Click to restart",
  "shell.update.unavailable": "Auto update unavailable",
  "shell.update.contact": "Contact developer",

  "shell.commandMenu.title": "Command menu",
  "shell.commandMenu.placeholder": "Type a command or search",

  "shell.otp.label": "One-time passcode",
  "shell.otp.verified": "Verified",

  "shell.table.title": "Table",
  "shell.table.copy": "Copy ({keys})",
  "shell.table.export": "Export CSV",
  "shell.table.copied.one": "Copied {count} cell to the clipboard",
  "shell.table.copied.other": "Copied {count} cells to the clipboard",
  "shell.table.copyFailed": "Could not copy to the clipboard",
  "shell.table.exported": "Exported {file}",
  "shell.table.selected.one": "{count} cell selected",
  "shell.table.selected.other": "{count} cells selected",
  "shell.table.hint": "Click, Shift+click or drag to select. {keys} to copy.",
  "shell.table.hintEdit": "Double-click to edit.",

  // Settings, General: the section titles and the interface size steps.
  "shell.settings.languageRegion": "Language and region",
  "shell.settings.startup": "Startup",
  "shell.settings.openAtLogin": "Open when the computer starts",
  "shell.settings.sizeSmall": "Small",
  "shell.settings.sizeMedium": "Medium",
  "shell.settings.sizeLarge": "Large",
  "shell.settings.sizeExtraLarge": "Extra large",
} satisfies Record<string, string>;

type Table = Partial<Record<keyof typeof en, string>>;

export const tr: Table = {
  "shell.tabs.label": "Ana sayfa görünümleri",
  "shell.tabs.dragHint": "{label}: sırayı değiştirmek için sürükleyin",

  "shell.resize.left": "{card} kartını soldan boyutlandır",
  "shell.resize.right": "{card} kartını sağdan boyutlandır",
  "shell.resize.top": "{card} kartını üstten boyutlandır",
  "shell.resize.bottom": "{card} kartını alttan boyutlandır",
  "shell.resize.topLeft": "{card} kartını sol üst köşeden boyutlandır",
  "shell.resize.topRight": "{card} kartını sağ üst köşeden boyutlandır",
  "shell.resize.bottomLeft": "{card} kartını sol alt köşeden boyutlandır",
  "shell.resize.corner": "{card} kartını boyutlandır",
  "shell.resize.hint": "Boyutlandırmak için sürükleyin",
  "shell.resize.seam": "İki yandaki kartları boyutlandır",
  "shell.resize.seamHint": "İki kartı birlikte boyutlandırmak için sürükleyin",

  "shell.update.ready": "Güncelleme hazır",
  "shell.update.restart": "Yeniden başlatmak için tıklayın",
  "shell.update.unavailable": "Otomatik güncelleme kullanılamıyor",
  "shell.update.contact": "Geliştiriciyle iletişime geçin",

  "shell.commandMenu.title": "Komut menüsü",
  "shell.commandMenu.placeholder": "Bir komut yazın veya arayın",

  "shell.otp.label": "Tek kullanımlık kod",
  "shell.otp.verified": "Doğrulandı",

  "shell.table.title": "Tablo",
  "shell.table.copy": "Kopyala ({keys})",
  "shell.table.export": "CSV olarak dışa aktar",
  "shell.table.copied.one": "{count} hücre panoya kopyalandı",
  "shell.table.copied.other": "{count} hücre panoya kopyalandı",
  "shell.table.copyFailed": "Panoya kopyalanamadı",
  "shell.table.exported": "{file} dışa aktarıldı",
  "shell.table.selected.one": "{count} hücre seçili",
  "shell.table.selected.other": "{count} hücre seçili",
  "shell.table.hint": "Seçmek için tıklayın, Shift ile tıklayın veya sürükleyin. Kopyalamak için {keys}.",
  "shell.table.hintEdit": "Düzenlemek için çift tıklayın.",

  // Settings, General: the section titles and the interface size steps.
  "shell.settings.languageRegion": "Dil ve bölge",
  "shell.settings.startup": "Açılış",
  "shell.settings.openAtLogin": "Bilgisayar açıldığında başlat",
  "shell.settings.sizeSmall": "Küçük",
  "shell.settings.sizeMedium": "Orta",
  "shell.settings.sizeLarge": "Büyük",
  "shell.settings.sizeExtraLarge": "Çok büyük",
};

export const de: Table = {
  "shell.tabs.label": "Startansichten",
  "shell.tabs.dragHint": "{label}: zum Umordnen ziehen",

  "shell.resize.left": "Größe der Karte {card} von links ändern",
  "shell.resize.right": "Größe der Karte {card} von rechts ändern",
  "shell.resize.top": "Größe der Karte {card} von oben ändern",
  "shell.resize.bottom": "Größe der Karte {card} von unten ändern",
  "shell.resize.topLeft": "Größe der Karte {card} von oben links ändern",
  "shell.resize.topRight": "Größe der Karte {card} von oben rechts ändern",
  "shell.resize.bottomLeft": "Größe der Karte {card} von unten links ändern",
  "shell.resize.corner": "Größe der Karte {card} ändern",
  "shell.resize.hint": "Zum Ändern der Größe ziehen",
  "shell.resize.seam": "Größe der Karten auf beiden Seiten ändern",
  "shell.resize.seamHint": "Ziehen, um beide Karten anzupassen",

  "shell.update.ready": "Update verfügbar",
  "shell.update.restart": "Zum Neustarten klicken",
  "shell.update.unavailable": "Automatisches Update nicht verfügbar",
  "shell.update.contact": "Entwickler kontaktieren",

  "shell.commandMenu.title": "Befehlsmenü",
  "shell.commandMenu.placeholder": "Befehl eingeben oder suchen",

  "shell.otp.label": "Einmalcode",
  "shell.otp.verified": "Bestätigt",

  "shell.table.title": "Tabelle",
  "shell.table.copy": "Kopieren ({keys})",
  "shell.table.export": "Als CSV exportieren",
  "shell.table.copied.one": "{count} Zelle in die Zwischenablage kopiert",
  "shell.table.copied.other": "{count} Zellen in die Zwischenablage kopiert",
  "shell.table.copyFailed": "Kopieren in die Zwischenablage nicht möglich",
  "shell.table.exported": "{file} exportiert",
  "shell.table.selected.one": "{count} Zelle ausgewählt",
  "shell.table.selected.other": "{count} Zellen ausgewählt",
  "shell.table.hint": "Klicken, mit Umschalt klicken oder ziehen zum Auswählen. {keys} zum Kopieren.",
  "shell.table.hintEdit": "Doppelklicken zum Bearbeiten.",

  // Settings, General: the section titles and the interface size steps.
  "shell.settings.languageRegion": "Sprache und Region",
  "shell.settings.startup": "Start",
  "shell.settings.openAtLogin": "Beim Hochfahren des Computers öffnen",
  "shell.settings.sizeSmall": "Klein",
  "shell.settings.sizeMedium": "Mittel",
  "shell.settings.sizeLarge": "Groß",
  "shell.settings.sizeExtraLarge": "Sehr groß",
};

export const fr: Table = {
  "shell.tabs.label": "Vues de l'accueil",
  "shell.tabs.dragHint": "{label} : faites glisser pour réorganiser",

  "shell.resize.left": "Redimensionner la carte {card} par la gauche",
  "shell.resize.right": "Redimensionner la carte {card} par la droite",
  "shell.resize.top": "Redimensionner la carte {card} par le haut",
  "shell.resize.bottom": "Redimensionner la carte {card} par le bas",
  "shell.resize.topLeft": "Redimensionner la carte {card} par le coin supérieur gauche",
  "shell.resize.topRight": "Redimensionner la carte {card} par le coin supérieur droit",
  "shell.resize.bottomLeft": "Redimensionner la carte {card} par le coin inférieur gauche",
  "shell.resize.corner": "Redimensionner la carte {card}",
  "shell.resize.hint": "Faites glisser pour redimensionner",
  "shell.resize.seam": "Redimensionner les cartes des deux côtés",
  "shell.resize.seamHint": "Faites glisser pour redimensionner les deux cartes",

  "shell.update.ready": "Mise à jour disponible",
  "shell.update.restart": "Cliquez pour redémarrer",
  "shell.update.unavailable": "Mise à jour automatique indisponible",
  "shell.update.contact": "Contactez le développeur",

  "shell.commandMenu.title": "Menu des commandes",
  "shell.commandMenu.placeholder": "Saisissez une commande ou recherchez",

  "shell.otp.label": "Code à usage unique",
  "shell.otp.verified": "Vérifié",

  "shell.table.title": "Tableau",
  "shell.table.copy": "Copier ({keys})",
  "shell.table.export": "Exporter en CSV",
  "shell.table.copied.one": "{count} cellule copiée dans le presse-papiers",
  "shell.table.copied.other": "{count} cellules copiées dans le presse-papiers",
  "shell.table.copyFailed": "Impossible de copier dans le presse-papiers",
  "shell.table.exported": "{file} exporté",
  "shell.table.selected.one": "{count} cellule sélectionnée",
  "shell.table.selected.other": "{count} cellules sélectionnées",
  "shell.table.hint": "Cliquez, Maj+clic ou faites glisser pour sélectionner. {keys} pour copier.",
  "shell.table.hintEdit": "Double-cliquez pour modifier.",

  // Settings, General: the section titles and the interface size steps.
  "shell.settings.languageRegion": "Langue et région",
  "shell.settings.startup": "Démarrage",
  "shell.settings.openAtLogin": "Ouvrir au démarrage de l'ordinateur",
  "shell.settings.sizeSmall": "Petite",
  "shell.settings.sizeMedium": "Moyenne",
  "shell.settings.sizeLarge": "Grande",
  "shell.settings.sizeExtraLarge": "Très grande",
};

export const es: Table = {
  "shell.tabs.label": "Vistas de inicio",
  "shell.tabs.dragHint": "{label}: arrastre para reordenar",

  "shell.resize.left": "Cambiar el tamaño de la tarjeta {card} desde la izquierda",
  "shell.resize.right": "Cambiar el tamaño de la tarjeta {card} desde la derecha",
  "shell.resize.top": "Cambiar el tamaño de la tarjeta {card} desde arriba",
  "shell.resize.bottom": "Cambiar el tamaño de la tarjeta {card} desde abajo",
  "shell.resize.topLeft": "Cambiar el tamaño de la tarjeta {card} desde la esquina superior izquierda",
  "shell.resize.topRight": "Cambiar el tamaño de la tarjeta {card} desde la esquina superior derecha",
  "shell.resize.bottomLeft": "Cambiar el tamaño de la tarjeta {card} desde la esquina inferior izquierda",
  "shell.resize.corner": "Cambiar el tamaño de la tarjeta {card}",
  "shell.resize.hint": "Arrastre para cambiar el tamaño",
  "shell.resize.seam": "Cambiar el tamaño de las tarjetas de ambos lados",
  "shell.resize.seamHint": "Arrastre para cambiar el tamaño de ambas tarjetas",

  "shell.update.ready": "Actualización disponible",
  "shell.update.restart": "Haga clic para reiniciar",
  "shell.update.unavailable": "Actualización automática no disponible",
  "shell.update.contact": "Contacte con el desarrollador",

  "shell.commandMenu.title": "Menú de comandos",
  "shell.commandMenu.placeholder": "Escriba un comando o busque",

  "shell.otp.label": "Código de un solo uso",
  "shell.otp.verified": "Verificado",

  "shell.table.title": "Tabla",
  "shell.table.copy": "Copiar ({keys})",
  "shell.table.export": "Exportar CSV",
  "shell.table.copied.one": "{count} celda copiada al portapapeles",
  "shell.table.copied.other": "{count} celdas copiadas al portapapeles",
  "shell.table.copyFailed": "No se pudo copiar al portapapeles",
  "shell.table.exported": "{file} exportado",
  "shell.table.selected.one": "{count} celda seleccionada",
  "shell.table.selected.other": "{count} celdas seleccionadas",
  "shell.table.hint": "Haga clic, Mayús+clic o arrastre para seleccionar. {keys} para copiar.",
  "shell.table.hintEdit": "Haga doble clic para editar.",

  // Settings, General: the section titles and the interface size steps.
  "shell.settings.languageRegion": "Idioma y región",
  "shell.settings.startup": "Inicio",
  "shell.settings.openAtLogin": "Abrir al iniciar el equipo",
  "shell.settings.sizeSmall": "Pequeño",
  "shell.settings.sizeMedium": "Mediano",
  "shell.settings.sizeLarge": "Grande",
  "shell.settings.sizeExtraLarge": "Muy grande",
};

export const it: Table = {
  "shell.tabs.label": "Viste della home",
  "shell.tabs.dragHint": "{label}: trascina per riordinare",

  "shell.resize.left": "Ridimensiona la scheda {card} da sinistra",
  "shell.resize.right": "Ridimensiona la scheda {card} da destra",
  "shell.resize.top": "Ridimensiona la scheda {card} dall'alto",
  "shell.resize.bottom": "Ridimensiona la scheda {card} dal basso",
  "shell.resize.topLeft": "Ridimensiona la scheda {card} dall'angolo in alto a sinistra",
  "shell.resize.topRight": "Ridimensiona la scheda {card} dall'angolo in alto a destra",
  "shell.resize.bottomLeft": "Ridimensiona la scheda {card} dall'angolo in basso a sinistra",
  "shell.resize.corner": "Ridimensiona la scheda {card}",
  "shell.resize.hint": "Trascina per ridimensionare",
  "shell.resize.seam": "Ridimensiona le schede su entrambi i lati",
  "shell.resize.seamHint": "Trascina per ridimensionare entrambe le schede",

  "shell.update.ready": "Aggiornamento disponibile",
  "shell.update.restart": "Fai clic per riavviare",
  "shell.update.unavailable": "Aggiornamento automatico non disponibile",
  "shell.update.contact": "Contatta lo sviluppatore",

  "shell.commandMenu.title": "Menu dei comandi",
  "shell.commandMenu.placeholder": "Digita un comando o cerca",

  "shell.otp.label": "Codice monouso",
  "shell.otp.verified": "Verificato",

  "shell.table.title": "Tabella",
  "shell.table.copy": "Copia ({keys})",
  "shell.table.export": "Esporta CSV",
  "shell.table.copied.one": "{count} cella copiata negli appunti",
  "shell.table.copied.other": "{count} celle copiate negli appunti",
  "shell.table.copyFailed": "Impossibile copiare negli appunti",
  "shell.table.exported": "{file} esportato",
  "shell.table.selected.one": "{count} cella selezionata",
  "shell.table.selected.other": "{count} celle selezionate",
  "shell.table.hint": "Fai clic, Maiusc+clic o trascina per selezionare. {keys} per copiare.",
  "shell.table.hintEdit": "Fai doppio clic per modificare.",

  // Settings, General: the section titles and the interface size steps.
  "shell.settings.languageRegion": "Lingua e regione",
  "shell.settings.startup": "Avvio",
  "shell.settings.openAtLogin": "Apri all'avvio del computer",
  "shell.settings.sizeSmall": "Piccola",
  "shell.settings.sizeMedium": "Media",
  "shell.settings.sizeLarge": "Grande",
  "shell.settings.sizeExtraLarge": "Molto grande",
};

export const ptBR: Table = {
  "shell.tabs.label": "Visualizações da página inicial",
  "shell.tabs.dragHint": "{label}: arraste para reordenar",

  "shell.resize.left": "Redimensionar o cartão {card} pela esquerda",
  "shell.resize.right": "Redimensionar o cartão {card} pela direita",
  "shell.resize.top": "Redimensionar o cartão {card} por cima",
  "shell.resize.bottom": "Redimensionar o cartão {card} por baixo",
  "shell.resize.topLeft": "Redimensionar o cartão {card} pelo canto superior esquerdo",
  "shell.resize.topRight": "Redimensionar o cartão {card} pelo canto superior direito",
  "shell.resize.bottomLeft": "Redimensionar o cartão {card} pelo canto inferior esquerdo",
  "shell.resize.corner": "Redimensionar o cartão {card}",
  "shell.resize.hint": "Arraste para redimensionar",
  "shell.resize.seam": "Redimensionar os cartões dos dois lados",
  "shell.resize.seamHint": "Arraste para redimensionar os dois cartões",

  "shell.update.ready": "Atualização disponível",
  "shell.update.restart": "Clique para reiniciar",
  "shell.update.unavailable": "Atualização automática indisponível",
  "shell.update.contact": "Fale com o desenvolvedor",

  "shell.commandMenu.title": "Menu de comandos",
  "shell.commandMenu.placeholder": "Digite um comando ou pesquise",

  "shell.otp.label": "Código de uso único",
  "shell.otp.verified": "Verificado",

  "shell.table.title": "Tabela",
  "shell.table.copy": "Copiar ({keys})",
  "shell.table.export": "Exportar CSV",
  "shell.table.copied.one": "{count} célula copiada para a área de transferência",
  "shell.table.copied.other": "{count} células copiadas para a área de transferência",
  "shell.table.copyFailed": "Não foi possível copiar para a área de transferência",
  "shell.table.exported": "{file} exportado",
  "shell.table.selected.one": "{count} célula selecionada",
  "shell.table.selected.other": "{count} células selecionadas",
  "shell.table.hint": "Clique, Shift+clique ou arraste para selecionar. {keys} para copiar.",
  "shell.table.hintEdit": "Clique duas vezes para editar.",

  // Settings, General: the section titles and the interface size steps.
  "shell.settings.languageRegion": "Idioma e região",
  "shell.settings.startup": "Inicialização",
  "shell.settings.openAtLogin": "Abrir ao iniciar o computador",
  "shell.settings.sizeSmall": "Pequeno",
  "shell.settings.sizeMedium": "Médio",
  "shell.settings.sizeLarge": "Grande",
  "shell.settings.sizeExtraLarge": "Muito grande",
};

export const ja: Table = {
  "shell.tabs.label": "ホームの表示",
  "shell.tabs.dragHint": "{label}：ドラッグして並べ替え",

  "shell.resize.left": "{card}カードのサイズを左端から変更",
  "shell.resize.right": "{card}カードのサイズを右端から変更",
  "shell.resize.top": "{card}カードのサイズを上端から変更",
  "shell.resize.bottom": "{card}カードのサイズを下端から変更",
  "shell.resize.topLeft": "{card}カードのサイズを左上から変更",
  "shell.resize.topRight": "{card}カードのサイズを右上から変更",
  "shell.resize.bottomLeft": "{card}カードのサイズを左下から変更",
  "shell.resize.corner": "{card}カードのサイズを変更",
  "shell.resize.hint": "ドラッグしてサイズを変更",
  "shell.resize.seam": "両側のカードのサイズを変更",
  "shell.resize.seamHint": "ドラッグして両方のカードのサイズを変更",

  "shell.update.ready": "アップデートがあります",
  "shell.update.restart": "クリックして再起動",
  "shell.update.unavailable": "自動アップデートは利用できません",
  "shell.update.contact": "開発者にお問い合わせください",

  "shell.commandMenu.title": "コマンドメニュー",
  "shell.commandMenu.placeholder": "コマンドを入力または検索",

  "shell.otp.label": "ワンタイムパスコード",
  "shell.otp.verified": "確認済み",

  "shell.table.title": "テーブル",
  "shell.table.copy": "コピー ({keys})",
  "shell.table.export": "CSVを書き出す",
  "shell.table.copied.one": "{count}個のセルをクリップボードにコピーしました",
  "shell.table.copied.other": "{count}個のセルをクリップボードにコピーしました",
  "shell.table.copyFailed": "クリップボードにコピーできませんでした",
  "shell.table.exported": "{file}を書き出しました",
  "shell.table.selected.one": "{count}個のセルを選択中",
  "shell.table.selected.other": "{count}個のセルを選択中",
  "shell.table.hint": "クリック、Shift+クリック、またはドラッグで選択。{keys}でコピー。",
  "shell.table.hintEdit": "ダブルクリックで編集。",

  // Settings, General: the section titles and the interface size steps.
  "shell.settings.languageRegion": "言語と地域",
  "shell.settings.startup": "起動",
  "shell.settings.openAtLogin": "コンピューターの起動時に開く",
  "shell.settings.sizeSmall": "小",
  "shell.settings.sizeMedium": "中",
  "shell.settings.sizeLarge": "大",
  "shell.settings.sizeExtraLarge": "特大",
};

export const zhCN: Table = {
  "shell.tabs.label": "主页视图",
  "shell.tabs.dragHint": "{label}：拖动以重新排序",

  "shell.resize.left": "从左侧调整{card}卡片大小",
  "shell.resize.right": "从右侧调整{card}卡片大小",
  "shell.resize.top": "从顶部调整{card}卡片大小",
  "shell.resize.bottom": "从底部调整{card}卡片大小",
  "shell.resize.topLeft": "从左上角调整{card}卡片大小",
  "shell.resize.topRight": "从右上角调整{card}卡片大小",
  "shell.resize.bottomLeft": "从左下角调整{card}卡片大小",
  "shell.resize.corner": "调整{card}卡片大小",
  "shell.resize.hint": "拖动以调整大小",
  "shell.resize.seam": "调整两侧卡片的大小",
  "shell.resize.seamHint": "拖动以同时调整两张卡片的大小",

  "shell.update.ready": "有可用更新",
  "shell.update.restart": "点击重新启动",
  "shell.update.unavailable": "自动更新不可用",
  "shell.update.contact": "请联系开发者",

  "shell.commandMenu.title": "命令菜单",
  "shell.commandMenu.placeholder": "输入命令或搜索",

  "shell.otp.label": "一次性验证码",
  "shell.otp.verified": "已验证",

  "shell.table.title": "表格",
  "shell.table.copy": "复制 ({keys})",
  "shell.table.export": "导出 CSV",
  "shell.table.copied.one": "已将 {count} 个单元格复制到剪贴板",
  "shell.table.copied.other": "已将 {count} 个单元格复制到剪贴板",
  "shell.table.copyFailed": "无法复制到剪贴板",
  "shell.table.exported": "已导出 {file}",
  "shell.table.selected.one": "已选择 {count} 个单元格",
  "shell.table.selected.other": "已选择 {count} 个单元格",
  "shell.table.hint": "单击、按住 Shift 单击或拖动以选择。按 {keys} 复制。",
  "shell.table.hintEdit": "双击以编辑。",

  // Settings, General: the section titles and the interface size steps.
  "shell.settings.languageRegion": "语言和地区",
  "shell.settings.startup": "启动",
  "shell.settings.openAtLogin": "电脑启动时打开",
  "shell.settings.sizeSmall": "小",
  "shell.settings.sizeMedium": "中",
  "shell.settings.sizeLarge": "大",
  "shell.settings.sizeExtraLarge": "特大",
};

export const ko: Table = {
  "shell.tabs.label": "홈 보기",
  "shell.tabs.dragHint": "{label}: 드래그하여 순서 변경",

  "shell.resize.left": "{card} 카드 크기를 왼쪽에서 조절",
  "shell.resize.right": "{card} 카드 크기를 오른쪽에서 조절",
  "shell.resize.top": "{card} 카드 크기를 위쪽에서 조절",
  "shell.resize.bottom": "{card} 카드 크기를 아래쪽에서 조절",
  "shell.resize.topLeft": "{card} 카드 크기를 왼쪽 위에서 조절",
  "shell.resize.topRight": "{card} 카드 크기를 오른쪽 위에서 조절",
  "shell.resize.bottomLeft": "{card} 카드 크기를 왼쪽 아래에서 조절",
  "shell.resize.corner": "{card} 카드 크기 조절",
  "shell.resize.hint": "드래그하여 크기 조절",
  "shell.resize.seam": "양쪽 카드 크기 조절",
  "shell.resize.seamHint": "드래그하여 두 카드의 크기를 함께 조절",

  "shell.update.ready": "업데이트 가능",
  "shell.update.restart": "클릭하여 다시 시작",
  "shell.update.unavailable": "자동 업데이트를 사용할 수 없음",
  "shell.update.contact": "개발자에게 문의하세요",

  "shell.commandMenu.title": "명령 메뉴",
  "shell.commandMenu.placeholder": "명령을 입력하거나 검색",

  "shell.otp.label": "일회용 인증 코드",
  "shell.otp.verified": "인증됨",

  "shell.table.title": "표",
  "shell.table.copy": "복사 ({keys})",
  "shell.table.export": "CSV 내보내기",
  "shell.table.copied.one": "셀 {count}개를 클립보드에 복사했습니다",
  "shell.table.copied.other": "셀 {count}개를 클립보드에 복사했습니다",
  "shell.table.copyFailed": "클립보드에 복사할 수 없습니다",
  "shell.table.exported": "{file} 내보내기 완료",
  "shell.table.selected.one": "셀 {count}개 선택됨",
  "shell.table.selected.other": "셀 {count}개 선택됨",
  "shell.table.hint": "클릭, Shift+클릭 또는 드래그하여 선택하세요. {keys}로 복사합니다.",
  "shell.table.hintEdit": "더블클릭하여 편집하세요.",

  // Settings, General: the section titles and the interface size steps.
  "shell.settings.languageRegion": "언어 및 지역",
  "shell.settings.startup": "시작",
  "shell.settings.openAtLogin": "컴퓨터를 시작할 때 열기",
  "shell.settings.sizeSmall": "작게",
  "shell.settings.sizeMedium": "보통",
  "shell.settings.sizeLarge": "크게",
  "shell.settings.sizeExtraLarge": "아주 크게",
};
