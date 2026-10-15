/**
 * Settings, System pane. Kept in its own area file so it can change while
 * other settings panes are being edited. Same rules as messages/en.ts:
 * `{name}` placeholders kept in every language, and no em dash or en dash
 * anywhere (shared/copy-rules.ts).
 */
export const en = {
  "system.advanced": "Advanced",

  "system.update.current": "Up to date",
  "system.update.checkedAt": "Checked at {time}",
  "system.update.available": "Version {version} is downloading",
  "system.update.failed": "Could not check",
  "system.update.unsigned": "Version {version} is out",
  "system.update.download": "Download",

  "system.quickOpen.label": "Quick open shortcut",
  "system.quickOpen.description": "Brings Falcon forward from any app.",
  "system.quickOpen.set": "Set shortcut",
  "system.quickOpen.clearLabel": "Clear the quick open shortcut",
  "system.quickOpen.change": "Change the quick open shortcut, now {keys}",
  "system.quickOpen.recording": "Press the keys for quick open, or Esc to cancel",
  "system.quickOpen.pressKeys": "Press keys",
  "system.quickOpen.error.unusable": "That key cannot be used for a shortcut.",
  "system.quickOpen.error.needsModifier": "Hold {mod} or {alt} with {keys}, or it would fire while you type in other apps.",
  "system.quickOpen.error.reserved": "Other apps use {keys} for everyday commands.",
  "system.quickOpen.error.inApp": "{keys} already opens \"{label}\" in Falcon.",
  "system.quickOpen.error.taken": "Another app already uses {keys}.",
  "system.quickOpen.error.invalid": "{keys} cannot be used as a shortcut.",
  "system.quickOpen.error.failed": "Could not save the shortcut.",
  "system.quickOpen.notRegistered": "Another app is using {keys}, so it does nothing right now.",

  "system.tray.label": "System tray",
  "system.tray.labelMac": "Menu bar",
  "system.tray.description": "Closing the window keeps Falcon running in the tray, so agents and notifications carry on.",
  "system.tray.descriptionMac":
    "Closing the window keeps Falcon running in the menu bar, so agents and notifications carry on.",

  "system.awake.label": "Keep computer awake",
  "system.awake.description":
    "Prevents idle sleep while Falcon is open, so agents check on schedule. The display can still turn off, and closing the lid still puts the computer to sleep.",

  "system.folder.label": "Storage folder",
  "system.folder.storedAt": "Your data is stored at {path}",
  "system.folder.open": "Open {path}",
  "system.folder.change": "Change",
  "system.folder.copying": "Copying",
  "system.folder.moved": "Your data was copied to {path}. Falcon switches to it on the next start.",
  "system.folder.previous": "The old folder stays where it is. You can delete it yourself once you no longer need it.",
  "system.folder.restartManually": "Restart Falcon to switch.",
  "system.folder.missing": "The chosen folder {path} could not be found, so Falcon is using its default folder for now.",
  "system.folder.envSet": "Set by FALCON_DATA_ROOT for this run.",
  "system.folder.error.sameFolder": "That is already the storage folder.",
  "system.folder.error.insideCurrent": "That folder is inside the current storage folder.",
  "system.folder.error.notEmpty": "That folder already has a Falcon folder with files in it.",
  "system.folder.error.notWritable": "Falcon cannot write to that folder.",
  "system.folder.error.copyFailed": "The copy did not finish. Nothing has changed.",
  "system.folder.error.verifyFailed": "The copy did not match the original. Nothing has changed.",
  "system.folder.error.unavailable": "The storage folder cannot be changed right now.",
} satisfies Record<string, string>;

type Table = Partial<Record<keyof typeof en, string>>;

export const tr: Table = {
  "system.advanced": "Gelişmiş",

  "system.update.current": "Güncel",
  "system.update.checkedAt": "{time} saatinde denetlendi",
  "system.update.available": "{version} sürümü indiriliyor",
  "system.update.failed": "Denetlenemedi",
  "system.update.unsigned": "{version} sürümü çıktı",
  "system.update.download": "İndir",

  "system.quickOpen.label": "Hızlı açma kısayolu",
  "system.quickOpen.description": "Falcon'u herhangi bir uygulamadan öne getirir.",
  "system.quickOpen.set": "Kısayol ayarla",
  "system.quickOpen.clearLabel": "Hızlı açma kısayolunu temizle",
  "system.quickOpen.change": "Hızlı açma kısayolunu değiştir, şu an {keys}",
  "system.quickOpen.recording": "Hızlı açma için tuşlara basın ya da iptal etmek için Esc'ye basın",
  "system.quickOpen.pressKeys": "Tuşlara basın",
  "system.quickOpen.error.unusable": "Bu tuş kısayol olarak kullanılamaz.",
  "system.quickOpen.error.needsModifier":
    "{keys} ile birlikte {mod} ya da {alt} tuşunu basılı tutun, yoksa diğer uygulamalarda yazarken tetiklenir.",
  "system.quickOpen.error.reserved": "Diğer uygulamalar {keys} kısayolunu günlük komutlar için kullanır.",
  "system.quickOpen.error.inApp": "{keys} Falcon içinde zaten \"{label}\" açıyor.",
  "system.quickOpen.error.taken": "{keys} kısayolunu başka bir uygulama kullanıyor.",
  "system.quickOpen.error.invalid": "{keys} kısayol olarak kullanılamaz.",
  "system.quickOpen.error.failed": "Kısayol kaydedilemedi.",
  "system.quickOpen.notRegistered": "{keys} kısayolunu başka bir uygulama kullandığı için şu an bir şey yapmıyor.",

  "system.tray.label": "Sistem tepsisi",
  "system.tray.labelMac": "Menü çubuğu",
  "system.tray.description":
    "Pencereyi kapatınca Falcon tepside çalışmaya devam eder, böylece ajanlar ve bildirimler sürer.",
  "system.tray.descriptionMac":
    "Pencereyi kapatınca Falcon menü çubuğunda çalışmaya devam eder, böylece ajanlar ve bildirimler sürer.",

  "system.awake.label": "Bilgisayarı uyanık tut",
  "system.awake.description":
    "Falcon açıkken boşta uykuya geçmeyi engeller, böylece ajanlar zamanında denetler. Ekran yine kapanabilir ve kapağı kapatmak bilgisayarı yine uyutur.",

  "system.folder.label": "Depolama klasörü",
  "system.folder.storedAt": "Verileriniz şurada: {path}",
  "system.folder.open": "{path} klasörünü aç",
  "system.folder.change": "Değiştir",
  "system.folder.copying": "Kopyalanıyor",
  "system.folder.moved": "Verileriniz {path} konumuna kopyalandı. Falcon bir sonraki açılışta ona geçer.",
  "system.folder.previous": "Eski klasör yerinde kalır. Artık gerekmediğinde kendiniz silebilirsiniz.",
  "system.folder.restartManually": "Geçmek için Falcon'u yeniden başlatın.",
  "system.folder.missing": "Seçilen {path} klasörü bulunamadı, bu yüzden Falcon şimdilik varsayılan klasörünü kullanıyor.",
  "system.folder.envSet": "Bu çalıştırma için FALCON_DATA_ROOT ile ayarlandı.",
  "system.folder.error.sameFolder": "Bu zaten depolama klasörü.",
  "system.folder.error.insideCurrent": "Bu klasör mevcut depolama klasörünün içinde.",
  "system.folder.error.notEmpty": "Bu klasörde içinde dosya olan bir Falcon klasörü zaten var.",
  "system.folder.error.notWritable": "Falcon bu klasöre yazamıyor.",
  "system.folder.error.copyFailed": "Kopyalama tamamlanmadı. Hiçbir şey değişmedi.",
  "system.folder.error.verifyFailed": "Kopya asılla eşleşmedi. Hiçbir şey değişmedi.",
  "system.folder.error.unavailable": "Depolama klasörü şu an değiştirilemiyor.",
};

export const de: Table = {
  "system.advanced": "Erweitert",

  "system.update.current": "Aktuell",
  "system.update.checkedAt": "Geprüft um {time}",
  "system.update.available": "Version {version} wird geladen",
  "system.update.failed": "Prüfung fehlgeschlagen",
  "system.update.unsigned": "Version {version} ist erschienen",
  "system.update.download": "Herunterladen",

  "system.quickOpen.label": "Kürzel zum schnellen Öffnen",
  "system.quickOpen.description": "Holt Falcon aus jeder App nach vorn.",
  "system.quickOpen.set": "Kürzel festlegen",
  "system.quickOpen.clearLabel": "Kürzel zum schnellen Öffnen entfernen",
  "system.quickOpen.change": "Kürzel zum schnellen Öffnen ändern, derzeit {keys}",
  "system.quickOpen.recording": "Tasten zum schnellen Öffnen drücken, Esc bricht ab",
  "system.quickOpen.pressKeys": "Tasten drücken",
  "system.quickOpen.error.unusable": "Diese Taste kann nicht als Kürzel dienen.",
  "system.quickOpen.error.needsModifier":
    "Halten Sie {mod} oder {alt} mit {keys}, sonst würde es beim Tippen in anderen Apps auslösen.",
  "system.quickOpen.error.reserved": "Andere Apps nutzen {keys} für alltägliche Befehle.",
  "system.quickOpen.error.inApp": "{keys} öffnet in Falcon bereits \"{label}\".",
  "system.quickOpen.error.taken": "Eine andere App nutzt {keys} bereits.",
  "system.quickOpen.error.invalid": "{keys} kann nicht als Kürzel dienen.",
  "system.quickOpen.error.failed": "Das Kürzel konnte nicht gespeichert werden.",
  "system.quickOpen.notRegistered": "Eine andere App nutzt {keys}, daher bewirkt es gerade nichts.",

  "system.tray.label": "Infobereich",
  "system.tray.labelMac": "Menüleiste",
  "system.tray.description":
    "Nach dem Schließen des Fensters läuft Falcon im Infobereich weiter, damit Agenten und Mitteilungen weiterarbeiten.",
  "system.tray.descriptionMac":
    "Nach dem Schließen des Fensters läuft Falcon in der Menüleiste weiter, damit Agenten und Mitteilungen weiterarbeiten.",

  "system.awake.label": "Computer wach halten",
  "system.awake.description":
    "Verhindert den Ruhezustand bei Inaktivität, solange Falcon geöffnet ist, damit Agenten planmäßig prüfen. Der Bildschirm kann sich trotzdem ausschalten, und Zuklappen versetzt den Computer weiterhin in den Ruhezustand.",

  "system.folder.label": "Speicherordner",
  "system.folder.storedAt": "Ihre Daten liegen unter {path}",
  "system.folder.open": "{path} öffnen",
  "system.folder.change": "Ändern",
  "system.folder.copying": "Wird kopiert",
  "system.folder.moved": "Ihre Daten wurden nach {path} kopiert. Falcon wechselt beim nächsten Start dorthin.",
  "system.folder.previous":
    "Der alte Ordner bleibt, wo er ist. Sie können ihn selbst löschen, sobald Sie ihn nicht mehr brauchen.",
  "system.folder.restartManually": "Starten Sie Falcon neu, um zu wechseln.",
  "system.folder.missing":
    "Der gewählte Ordner {path} wurde nicht gefunden, daher nutzt Falcon vorerst seinen Standardordner.",
  "system.folder.envSet": "Für diesen Lauf durch FALCON_DATA_ROOT festgelegt.",
  "system.folder.error.sameFolder": "Das ist bereits der Speicherordner.",
  "system.folder.error.insideCurrent": "Dieser Ordner liegt im aktuellen Speicherordner.",
  "system.folder.error.notEmpty": "Dieser Ordner enthält bereits einen Falcon-Ordner mit Dateien.",
  "system.folder.error.notWritable": "Falcon kann in diesen Ordner nicht schreiben.",
  "system.folder.error.copyFailed": "Das Kopieren wurde nicht abgeschlossen. Nichts wurde geändert.",
  "system.folder.error.verifyFailed": "Die Kopie stimmte nicht mit dem Original überein. Nichts wurde geändert.",
  "system.folder.error.unavailable": "Der Speicherordner kann gerade nicht geändert werden.",
};

export const fr: Table = {
  "system.advanced": "Avancé",

  "system.update.current": "À jour",
  "system.update.checkedAt": "Vérifié à {time}",
  "system.update.available": "Téléchargement de la version {version}",
  "system.update.failed": "Vérification impossible",
  "system.update.unsigned": "La version {version} est disponible",
  "system.update.download": "Télécharger",

  "system.quickOpen.label": "Raccourci d'ouverture rapide",
  "system.quickOpen.description": "Affiche Falcon depuis n'importe quelle app.",
  "system.quickOpen.set": "Définir un raccourci",
  "system.quickOpen.clearLabel": "Effacer le raccourci d'ouverture rapide",
  "system.quickOpen.change": "Modifier le raccourci d'ouverture rapide, actuellement {keys}",
  "system.quickOpen.recording": "Appuyez sur les touches pour l'ouverture rapide, ou sur Échap pour annuler",
  "system.quickOpen.pressKeys": "Appuyez sur les touches",
  "system.quickOpen.error.unusable": "Cette touche ne peut pas servir de raccourci.",
  "system.quickOpen.error.needsModifier":
    "Maintenez {mod} ou {alt} avec {keys}, sinon il se déclencherait pendant la saisie dans d'autres apps.",
  "system.quickOpen.error.reserved": "Les autres apps utilisent {keys} pour des commandes courantes.",
  "system.quickOpen.error.inApp": "{keys} ouvre déjà « {label} » dans Falcon.",
  "system.quickOpen.error.taken": "Une autre app utilise déjà {keys}.",
  "system.quickOpen.error.invalid": "{keys} ne peut pas servir de raccourci.",
  "system.quickOpen.error.failed": "Impossible d'enregistrer le raccourci.",
  "system.quickOpen.notRegistered": "Une autre app utilise {keys}, il est donc sans effet pour le moment.",

  "system.tray.label": "Zone de notification",
  "system.tray.labelMac": "Barre des menus",
  "system.tray.description":
    "Fermer la fenêtre laisse Falcon tourner dans la zone de notification, pour que les agents et les notifications continuent.",
  "system.tray.descriptionMac":
    "Fermer la fenêtre laisse Falcon tourner dans la barre des menus, pour que les agents et les notifications continuent.",

  "system.awake.label": "Garder l'ordinateur éveillé",
  "system.awake.description":
    "Empêche la mise en veille par inactivité tant que Falcon est ouvert, pour que les agents vérifient à l'heure. L'écran peut quand même s'éteindre, et fermer le capot met toujours l'ordinateur en veille.",

  "system.folder.label": "Dossier de stockage",
  "system.folder.storedAt": "Vos données sont stockées dans {path}",
  "system.folder.open": "Ouvrir {path}",
  "system.folder.change": "Modifier",
  "system.folder.copying": "Copie en cours",
  "system.folder.moved": "Vos données ont été copiées dans {path}. Falcon l'utilise dès le prochain démarrage.",
  "system.folder.previous":
    "L'ancien dossier reste en place. Vous pouvez le supprimer vous-même quand vous n'en avez plus besoin.",
  "system.folder.restartManually": "Redémarrez Falcon pour basculer.",
  "system.folder.missing":
    "Le dossier choisi {path} est introuvable, Falcon utilise donc son dossier par défaut pour le moment.",
  "system.folder.envSet": "Défini par FALCON_DATA_ROOT pour cette exécution.",
  "system.folder.error.sameFolder": "C'est déjà le dossier de stockage.",
  "system.folder.error.insideCurrent": "Ce dossier se trouve dans le dossier de stockage actuel.",
  "system.folder.error.notEmpty": "Ce dossier contient déjà un dossier Falcon avec des fichiers.",
  "system.folder.error.notWritable": "Falcon ne peut pas écrire dans ce dossier.",
  "system.folder.error.copyFailed": "La copie n'a pas abouti. Rien n'a changé.",
  "system.folder.error.verifyFailed": "La copie ne correspond pas à l'original. Rien n'a changé.",
  "system.folder.error.unavailable": "Le dossier de stockage ne peut pas être modifié pour le moment.",
};

export const es: Table = {
  "system.advanced": "Avanzado",

  "system.update.current": "Actualizado",
  "system.update.checkedAt": "Comprobado a las {time}",
  "system.update.available": "Descargando la versión {version}",
  "system.update.failed": "No se pudo comprobar",
  "system.update.unsigned": "Ya está la versión {version}",
  "system.update.download": "Descargar",

  "system.quickOpen.label": "Atajo de apertura rápida",
  "system.quickOpen.description": "Muestra Falcon desde cualquier app.",
  "system.quickOpen.set": "Definir atajo",
  "system.quickOpen.clearLabel": "Quitar el atajo de apertura rápida",
  "system.quickOpen.change": "Cambiar el atajo de apertura rápida, ahora {keys}",
  "system.quickOpen.recording": "Pulsa las teclas para la apertura rápida, o Esc para cancelar",
  "system.quickOpen.pressKeys": "Pulsa las teclas",
  "system.quickOpen.error.unusable": "Esa tecla no sirve como atajo.",
  "system.quickOpen.error.needsModifier":
    "Mantén {mod} o {alt} con {keys}; si no, se activaría al escribir en otras apps.",
  "system.quickOpen.error.reserved": "Otras apps usan {keys} para órdenes habituales.",
  "system.quickOpen.error.inApp": "{keys} ya abre «{label}» en Falcon.",
  "system.quickOpen.error.taken": "Otra app ya usa {keys}.",
  "system.quickOpen.error.invalid": "{keys} no sirve como atajo.",
  "system.quickOpen.error.failed": "No se pudo guardar el atajo.",
  "system.quickOpen.notRegistered": "Otra app está usando {keys}, así que ahora no hace nada.",

  "system.tray.label": "Bandeja del sistema",
  "system.tray.labelMac": "Barra de menús",
  "system.tray.description":
    "Al cerrar la ventana, Falcon sigue funcionando en la bandeja, así que los agentes y las notificaciones continúan.",
  "system.tray.descriptionMac":
    "Al cerrar la ventana, Falcon sigue funcionando en la barra de menús, así que los agentes y las notificaciones continúan.",

  "system.awake.label": "Mantener el equipo activo",
  "system.awake.description":
    "Evita la suspensión por inactividad mientras Falcon está abierto, para que los agentes revisen a su hora. La pantalla puede apagarse igualmente, y cerrar la tapa sigue suspendiendo el equipo.",

  "system.folder.label": "Carpeta de almacenamiento",
  "system.folder.storedAt": "Tus datos se guardan en {path}",
  "system.folder.open": "Abrir {path}",
  "system.folder.change": "Cambiar",
  "system.folder.copying": "Copiando",
  "system.folder.moved": "Tus datos se han copiado a {path}. Falcon pasa a usarla en el próximo inicio.",
  "system.folder.previous": "La carpeta anterior se queda donde está. Puedes borrarla tú cuando ya no la necesites.",
  "system.folder.restartManually": "Reinicia Falcon para cambiar.",
  "system.folder.missing":
    "No se encontró la carpeta elegida {path}, así que Falcon usa por ahora su carpeta predeterminada.",
  "system.folder.envSet": "Definida por FALCON_DATA_ROOT para esta ejecución.",
  "system.folder.error.sameFolder": "Esa ya es la carpeta de almacenamiento.",
  "system.folder.error.insideCurrent": "Esa carpeta está dentro de la carpeta de almacenamiento actual.",
  "system.folder.error.notEmpty": "Esa carpeta ya tiene una carpeta Falcon con archivos.",
  "system.folder.error.notWritable": "Falcon no puede escribir en esa carpeta.",
  "system.folder.error.copyFailed": "La copia no terminó. No ha cambiado nada.",
  "system.folder.error.verifyFailed": "La copia no coincide con el original. No ha cambiado nada.",
  "system.folder.error.unavailable": "Ahora no se puede cambiar la carpeta de almacenamiento.",
};

export const it: Table = {
  "system.advanced": "Avanzate",

  "system.update.current": "Aggiornato",
  "system.update.checkedAt": "Controllato alle {time}",
  "system.update.available": "Download della versione {version} in corso",
  "system.update.failed": "Controllo non riuscito",
  "system.update.unsigned": "È uscita la versione {version}",
  "system.update.download": "Scarica",

  "system.quickOpen.label": "Scorciatoia di apertura rapida",
  "system.quickOpen.description": "Porta Falcon in primo piano da qualsiasi app.",
  "system.quickOpen.set": "Imposta scorciatoia",
  "system.quickOpen.clearLabel": "Rimuovi la scorciatoia di apertura rapida",
  "system.quickOpen.change": "Cambia la scorciatoia di apertura rapida, ora {keys}",
  "system.quickOpen.recording": "Premi i tasti per l'apertura rapida, o Esc per annullare",
  "system.quickOpen.pressKeys": "Premi i tasti",
  "system.quickOpen.error.unusable": "Questo tasto non può essere usato come scorciatoia.",
  "system.quickOpen.error.needsModifier":
    "Tieni premuto {mod} o {alt} con {keys}, altrimenti scatterebbe mentre scrivi in altre app.",
  "system.quickOpen.error.reserved": "Le altre app usano {keys} per i comandi di tutti i giorni.",
  "system.quickOpen.error.inApp": "{keys} apre già \"{label}\" in Falcon.",
  "system.quickOpen.error.taken": "Un'altra app usa già {keys}.",
  "system.quickOpen.error.invalid": "{keys} non può essere usata come scorciatoia.",
  "system.quickOpen.error.failed": "Impossibile salvare la scorciatoia.",
  "system.quickOpen.notRegistered": "Un'altra app sta usando {keys}, quindi al momento non fa nulla.",

  "system.tray.label": "Area di notifica",
  "system.tray.labelMac": "Barra dei menu",
  "system.tray.description":
    "Chiudendo la finestra Falcon resta attivo nell'area di notifica, così agenti e notifiche continuano.",
  "system.tray.descriptionMac":
    "Chiudendo la finestra Falcon resta attivo nella barra dei menu, così agenti e notifiche continuano.",

  "system.awake.label": "Mantieni il computer attivo",
  "system.awake.description":
    "Impedisce la sospensione per inattività mentre Falcon è aperto, così gli agenti controllano in orario. Lo schermo può comunque spegnersi, e chiudere il coperchio sospende comunque il computer.",

  "system.folder.label": "Cartella di archiviazione",
  "system.folder.storedAt": "I tuoi dati sono in {path}",
  "system.folder.open": "Apri {path}",
  "system.folder.change": "Cambia",
  "system.folder.copying": "Copia in corso",
  "system.folder.moved": "I tuoi dati sono stati copiati in {path}. Falcon passa a questa cartella al prossimo avvio.",
  "system.folder.previous": "La vecchia cartella resta dov'è. Puoi eliminarla tu quando non ti serve più.",
  "system.folder.restartManually": "Riavvia Falcon per passare alla nuova cartella.",
  "system.folder.missing":
    "La cartella scelta {path} non è stata trovata, quindi per ora Falcon usa la sua cartella predefinita.",
  "system.folder.envSet": "Impostata da FALCON_DATA_ROOT per questa esecuzione.",
  "system.folder.error.sameFolder": "Questa è già la cartella di archiviazione.",
  "system.folder.error.insideCurrent": "Questa cartella si trova dentro la cartella di archiviazione attuale.",
  "system.folder.error.notEmpty": "Questa cartella contiene già una cartella Falcon con dei file.",
  "system.folder.error.notWritable": "Falcon non può scrivere in questa cartella.",
  "system.folder.error.copyFailed": "La copia non è stata completata. Non è cambiato nulla.",
  "system.folder.error.verifyFailed": "La copia non corrisponde all'originale. Non è cambiato nulla.",
  "system.folder.error.unavailable": "Al momento non è possibile cambiare la cartella di archiviazione.",
};

export const ptBR: Table = {
  "system.advanced": "Avançado",

  "system.update.current": "Atualizado",
  "system.update.checkedAt": "Verificado às {time}",
  "system.update.available": "Baixando a versão {version}",
  "system.update.failed": "Não foi possível verificar",
  "system.update.unsigned": "A versão {version} saiu",
  "system.update.download": "Baixar",

  "system.quickOpen.label": "Atalho de abertura rápida",
  "system.quickOpen.description": "Traz o Falcon para a frente a partir de qualquer app.",
  "system.quickOpen.set": "Definir atalho",
  "system.quickOpen.clearLabel": "Limpar o atalho de abertura rápida",
  "system.quickOpen.change": "Alterar o atalho de abertura rápida, agora {keys}",
  "system.quickOpen.recording": "Pressione as teclas para a abertura rápida, ou Esc para cancelar",
  "system.quickOpen.pressKeys": "Pressione as teclas",
  "system.quickOpen.error.unusable": "Essa tecla não pode ser usada como atalho.",
  "system.quickOpen.error.needsModifier":
    "Segure {mod} ou {alt} com {keys}, senão ele dispararia enquanto você digita em outros apps.",
  "system.quickOpen.error.reserved": "Outros apps usam {keys} para comandos do dia a dia.",
  "system.quickOpen.error.inApp": "{keys} já abre \"{label}\" no Falcon.",
  "system.quickOpen.error.taken": "Outro app já usa {keys}.",
  "system.quickOpen.error.invalid": "{keys} não pode ser usado como atalho.",
  "system.quickOpen.error.failed": "Não foi possível salvar o atalho.",
  "system.quickOpen.notRegistered": "Outro app está usando {keys}, então ele não faz nada agora.",

  "system.tray.label": "Bandeja do sistema",
  "system.tray.labelMac": "Barra de menus",
  "system.tray.description":
    "Fechar a janela mantém o Falcon rodando na bandeja, para que agentes e notificações continuem.",
  "system.tray.descriptionMac":
    "Fechar a janela mantém o Falcon rodando na barra de menus, para que agentes e notificações continuem.",

  "system.awake.label": "Manter o computador ativo",
  "system.awake.description":
    "Impede a suspensão por inatividade enquanto o Falcon está aberto, para que os agentes verifiquem no horário. A tela ainda pode desligar, e fechar a tampa ainda suspende o computador.",

  "system.folder.label": "Pasta de armazenamento",
  "system.folder.storedAt": "Seus dados ficam em {path}",
  "system.folder.open": "Abrir {path}",
  "system.folder.change": "Alterar",
  "system.folder.copying": "Copiando",
  "system.folder.moved": "Seus dados foram copiados para {path}. O Falcon passa a usá-la na próxima inicialização.",
  "system.folder.previous": "A pasta antiga continua onde está. Você pode apagá-la quando não precisar mais dela.",
  "system.folder.restartManually": "Reinicie o Falcon para trocar.",
  "system.folder.missing":
    "A pasta escolhida {path} não foi encontrada, então o Falcon está usando a pasta padrão por enquanto.",
  "system.folder.envSet": "Definida por FALCON_DATA_ROOT nesta execução.",
  "system.folder.error.sameFolder": "Essa já é a pasta de armazenamento.",
  "system.folder.error.insideCurrent": "Essa pasta fica dentro da pasta de armazenamento atual.",
  "system.folder.error.notEmpty": "Essa pasta já tem uma pasta Falcon com arquivos.",
  "system.folder.error.notWritable": "O Falcon não consegue gravar nessa pasta.",
  "system.folder.error.copyFailed": "A cópia não terminou. Nada mudou.",
  "system.folder.error.verifyFailed": "A cópia não confere com o original. Nada mudou.",
  "system.folder.error.unavailable": "Não é possível alterar a pasta de armazenamento agora.",
};

export const ja: Table = {
  "system.advanced": "詳細設定",

  "system.update.current": "最新です",
  "system.update.checkedAt": "{time} に確認",
  "system.update.available": "バージョン {version} をダウンロード中",
  "system.update.failed": "確認できませんでした",
  "system.update.unsigned": "バージョン {version} が公開されています",
  "system.update.download": "ダウンロード",

  "system.quickOpen.label": "クイックオープンのショートカット",
  "system.quickOpen.description": "どのアプリからでもFalconを前面に表示します。",
  "system.quickOpen.set": "ショートカットを設定",
  "system.quickOpen.clearLabel": "クイックオープンのショートカットを解除",
  "system.quickOpen.change": "クイックオープンのショートカットを変更、現在は {keys}",
  "system.quickOpen.recording": "クイックオープンのキーを押してください。Esc でキャンセルします",
  "system.quickOpen.pressKeys": "キーを押してください",
  "system.quickOpen.error.unusable": "このキーはショートカットに使えません。",
  "system.quickOpen.error.needsModifier":
    "{keys} と一緒に {mod} か {alt} を押してください。押さないと、ほかのアプリで入力中に反応してしまいます。",
  "system.quickOpen.error.reserved": "{keys} はほかのアプリで日常的なコマンドに使われています。",
  "system.quickOpen.error.inApp": "{keys} はFalcon内ですでに「{label}」を開きます。",
  "system.quickOpen.error.taken": "{keys} はすでに別のアプリが使っています。",
  "system.quickOpen.error.invalid": "{keys} はショートカットに使えません。",
  "system.quickOpen.error.failed": "ショートカットを保存できませんでした。",
  "system.quickOpen.notRegistered": "{keys} は別のアプリが使っているため、現在は何も起きません。",

  "system.tray.label": "システムトレイ",
  "system.tray.labelMac": "メニューバー",
  "system.tray.description": "ウィンドウを閉じてもFalconはトレイで動き続け、エージェントと通知も続きます。",
  "system.tray.descriptionMac": "ウィンドウを閉じてもFalconはメニューバーで動き続け、エージェントと通知も続きます。",

  "system.awake.label": "コンピュータをスリープさせない",
  "system.awake.description":
    "Falconを開いている間はアイドル時のスリープを防ぎ、エージェントが予定どおり確認できるようにします。ディスプレイは消えることがあり、ふたを閉じるとスリープします。",

  "system.folder.label": "保存先フォルダ",
  "system.folder.storedAt": "データの保存先: {path}",
  "system.folder.open": "{path} を開く",
  "system.folder.change": "変更",
  "system.folder.copying": "コピー中",
  "system.folder.moved": "データを {path} にコピーしました。次回の起動からFalconはこちらを使います。",
  "system.folder.previous": "以前のフォルダはそのまま残ります。不要になったらご自身で削除できます。",
  "system.folder.restartManually": "切り替えるにはFalconを再起動してください。",
  "system.folder.missing": "選択したフォルダ {path} が見つからないため、Falconは当面デフォルトのフォルダを使っています。",
  "system.folder.envSet": "この実行では FALCON_DATA_ROOT で指定されています。",
  "system.folder.error.sameFolder": "すでに保存先フォルダです。",
  "system.folder.error.insideCurrent": "このフォルダは現在の保存先フォルダの中にあります。",
  "system.folder.error.notEmpty": "このフォルダにはファイルの入ったFalconフォルダがすでにあります。",
  "system.folder.error.notWritable": "Falconはこのフォルダに書き込めません。",
  "system.folder.error.copyFailed": "コピーが完了しませんでした。何も変更されていません。",
  "system.folder.error.verifyFailed": "コピーが元のデータと一致しませんでした。何も変更されていません。",
  "system.folder.error.unavailable": "現在、保存先フォルダは変更できません。",
};

export const zhCN: Table = {
  "system.advanced": "高级",

  "system.update.current": "已是最新",
  "system.update.checkedAt": "检查于 {time}",
  "system.update.available": "正在下载版本 {version}",
  "system.update.failed": "无法检查",
  "system.update.unsigned": "版本 {version} 已发布",
  "system.update.download": "下载",

  "system.quickOpen.label": "快速打开快捷键",
  "system.quickOpen.description": "在任何应用中把 Falcon 调到前台。",
  "system.quickOpen.set": "设置快捷键",
  "system.quickOpen.clearLabel": "清除快速打开快捷键",
  "system.quickOpen.change": "更改快速打开快捷键，当前为 {keys}",
  "system.quickOpen.recording": "按下快速打开的按键，或按 Esc 取消",
  "system.quickOpen.pressKeys": "请按键",
  "system.quickOpen.error.unusable": "这个键不能用作快捷键。",
  "system.quickOpen.error.needsModifier": "请同时按住 {mod} 或 {alt} 与 {keys}，否则在其他应用中打字时也会触发。",
  "system.quickOpen.error.reserved": "其他应用用 {keys} 执行常用命令。",
  "system.quickOpen.error.inApp": "{keys} 在 Falcon 中已用于打开“{label}”。",
  "system.quickOpen.error.taken": "{keys} 已被其他应用占用。",
  "system.quickOpen.error.invalid": "{keys} 不能用作快捷键。",
  "system.quickOpen.error.failed": "无法保存快捷键。",
  "system.quickOpen.notRegistered": "{keys} 正被其他应用占用，因此目前不起作用。",

  "system.tray.label": "系统托盘",
  "system.tray.labelMac": "菜单栏",
  "system.tray.description": "关闭窗口后 Falcon 继续在托盘中运行，代理和通知也照常进行。",
  "system.tray.descriptionMac": "关闭窗口后 Falcon 继续在菜单栏中运行，代理和通知也照常进行。",

  "system.awake.label": "保持电脑唤醒",
  "system.awake.description":
    "Falcon 打开期间阻止电脑因闲置而睡眠，让代理按计划检查。显示器仍可关闭，合上盖子仍会让电脑睡眠。",

  "system.folder.label": "存储文件夹",
  "system.folder.storedAt": "你的数据存储在 {path}",
  "system.folder.open": "打开 {path}",
  "system.folder.change": "更改",
  "system.folder.copying": "正在复制",
  "system.folder.moved": "你的数据已复制到 {path}。下次启动时 Falcon 会改用它。",
  "system.folder.previous": "旧文件夹保留在原处。不再需要时可以自行删除。",
  "system.folder.restartManually": "重新启动 Falcon 以切换。",
  "system.folder.missing": "找不到所选文件夹 {path}，因此 Falcon 暂时使用默认文件夹。",
  "system.folder.envSet": "本次运行由 FALCON_DATA_ROOT 指定。",
  "system.folder.error.sameFolder": "这已经是存储文件夹。",
  "system.folder.error.insideCurrent": "该文件夹位于当前存储文件夹内。",
  "system.folder.error.notEmpty": "该文件夹中已有一个包含文件的 Falcon 文件夹。",
  "system.folder.error.notWritable": "Falcon 无法写入该文件夹。",
  "system.folder.error.copyFailed": "复制未完成。没有任何更改。",
  "system.folder.error.verifyFailed": "副本与原始数据不一致。没有任何更改。",
  "system.folder.error.unavailable": "目前无法更改存储文件夹。",
};

export const ko: Table = {
  "system.advanced": "고급",

  "system.update.current": "최신 버전",
  "system.update.checkedAt": "{time}에 확인함",
  "system.update.available": "버전 {version} 다운로드 중",
  "system.update.failed": "확인할 수 없음",
  "system.update.unsigned": "버전 {version} 출시됨",
  "system.update.download": "다운로드",

  "system.quickOpen.label": "빠른 열기 단축키",
  "system.quickOpen.description": "어떤 앱에서든 Falcon을 앞으로 가져옵니다.",
  "system.quickOpen.set": "단축키 설정",
  "system.quickOpen.clearLabel": "빠른 열기 단축키 지우기",
  "system.quickOpen.change": "빠른 열기 단축키 변경, 현재 {keys}",
  "system.quickOpen.recording": "빠른 열기에 쓸 키를 누르거나 Esc로 취소하세요",
  "system.quickOpen.pressKeys": "키를 누르세요",
  "system.quickOpen.error.unusable": "이 키는 단축키로 쓸 수 없습니다.",
  "system.quickOpen.error.needsModifier":
    "{keys}와 함께 {mod} 또는 {alt}를 누르세요. 그렇지 않으면 다른 앱에서 입력할 때 실행됩니다.",
  "system.quickOpen.error.reserved": "다른 앱에서 {keys}를 일상적인 명령에 사용합니다.",
  "system.quickOpen.error.inApp": "{keys}는 Falcon에서 이미 \"{label}\"을(를) 엽니다.",
  "system.quickOpen.error.taken": "{keys}는 이미 다른 앱이 사용 중입니다.",
  "system.quickOpen.error.invalid": "{keys}는 단축키로 쓸 수 없습니다.",
  "system.quickOpen.error.failed": "단축키를 저장할 수 없습니다.",
  "system.quickOpen.notRegistered": "다른 앱이 {keys}를 사용 중이라 지금은 작동하지 않습니다.",

  "system.tray.label": "시스템 트레이",
  "system.tray.labelMac": "메뉴 막대",
  "system.tray.description": "창을 닫아도 Falcon이 트레이에서 계속 실행되어 에이전트와 알림이 이어집니다.",
  "system.tray.descriptionMac": "창을 닫아도 Falcon이 메뉴 막대에서 계속 실행되어 에이전트와 알림이 이어집니다.",

  "system.awake.label": "컴퓨터 깨어 있게 유지",
  "system.awake.description":
    "Falcon이 열려 있는 동안 유휴 절전을 막아 에이전트가 일정대로 확인하게 합니다. 화면은 꺼질 수 있으며, 덮개를 닫으면 컴퓨터는 절전 모드로 전환됩니다.",

  "system.folder.label": "저장 폴더",
  "system.folder.storedAt": "데이터 저장 위치: {path}",
  "system.folder.open": "{path} 열기",
  "system.folder.change": "변경",
  "system.folder.copying": "복사 중",
  "system.folder.moved": "데이터를 {path}에 복사했습니다. 다음 실행부터 Falcon이 이 폴더를 사용합니다.",
  "system.folder.previous": "이전 폴더는 그대로 남아 있습니다. 더 이상 필요 없으면 직접 삭제할 수 있습니다.",
  "system.folder.restartManually": "전환하려면 Falcon을 다시 시작하세요.",
  "system.folder.missing": "선택한 폴더 {path}를 찾을 수 없어 Falcon이 당분간 기본 폴더를 사용합니다.",
  "system.folder.envSet": "이번 실행에서는 FALCON_DATA_ROOT로 지정되었습니다.",
  "system.folder.error.sameFolder": "이미 저장 폴더입니다.",
  "system.folder.error.insideCurrent": "이 폴더는 현재 저장 폴더 안에 있습니다.",
  "system.folder.error.notEmpty": "이 폴더에는 파일이 들어 있는 Falcon 폴더가 이미 있습니다.",
  "system.folder.error.notWritable": "Falcon이 이 폴더에 쓸 수 없습니다.",
  "system.folder.error.copyFailed": "복사를 마치지 못했습니다. 바뀐 것은 없습니다.",
  "system.folder.error.verifyFailed": "복사본이 원본과 일치하지 않습니다. 바뀐 것은 없습니다.",
  "system.folder.error.unavailable": "지금은 저장 폴더를 바꿀 수 없습니다.",
};
