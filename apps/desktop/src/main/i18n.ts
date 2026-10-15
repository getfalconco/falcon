/**
 * The few words the main process puts on screen itself: native notifications,
 * the save dialog's title, and the notes and errors the Notifications pane
 * shows as they come from here. The renderer has its own, much larger tables
 * (renderer/lib/i18n); this file is kept apart from them so the main bundle
 * never pulls in the renderer's messages.
 *
 * The language is the one the reader chose in the app: the renderer sends it
 * over `i18n:set-language` on startup and on every change, and `i18n-store.ts`
 * keeps it on disk, so a notification fired before the window has loaded
 * still reads in the last language. Until a choice has been seen, the
 * machine's language is used when Falcon has it, else English.
 *
 * Pure (no Electron, no fs) so it runs under `node --test`. Same copy rules
 * as the renderer: `{name}` placeholders kept in every language, no em dash
 * or en dash, no exclamation marks.
 */

export const MAIN_LANGUAGES = [
  "en-US",
  "tr-TR",
  "de-DE",
  "fr-FR",
  "es-ES",
  "it-IT",
  "pt-BR",
  "ja-JP",
  "zh-CN",
  "ko-KR",
] as const;

export type MainLanguage = (typeof MAIN_LANGUAGES)[number];

export function isMainLanguage(value: unknown): value is MainLanguage {
  return typeof value === "string" && (MAIN_LANGUAGES as readonly string[]).includes(value);
}

/**
 * The supported language a list of BCP 47 tags comes to, in the machine's
 * order: an exact tag, then the same language in another region. Traditional
 * Chinese falls through rather than reading Simplified. Mirrors
 * renderer/lib/i18n/languages.ts `resolveLanguage`.
 */
export function resolveMainLanguage(tags: readonly string[]): MainLanguage | null {
  for (const raw of tags) {
    const tag = raw.trim().replace(/_/g, "-");
    if (!tag) continue;
    const exact = MAIN_LANGUAGES.find((code) => code.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    if (/^zh-(hant|tw|hk|mo)\b/i.test(tag)) continue;
    const primary = tag.split("-")[0]!.toLowerCase();
    const same = MAIN_LANGUAGES.find((code) => code.split("-")[0]!.toLowerCase() === primary);
    if (same) return same;
  }
  return null;
}

const en = {
  "notify.update.readyTitle": "Falcon update ready",
  "notify.update.readyBody": "Version {version} is downloaded. Restart Falcon to install it.",
  "notify.update.availableTitle": "A newer Falcon is available",
  "notify.update.availableBody": "Version {version} is out. Download it to update.",

  "notify.events.titleOne": "Falcon: new market event",
  "notify.events.titleOther": "Falcon: {count} new market events",
  "notify.more": "+{count} more",

  "notify.signals.title": "Second-order signal: {ticker}",
  "notify.signals.reachesOne": "Reaches {count} name not priced in yet.",
  "notify.signals.reachesOther": "Reaches {count} names not priced in yet.",
  "notify.signals.openOne": "{count} open name",
  "notify.signals.openOther": "{count} open names",
  "notify.signals.batchTitle": "{count} new second-order signals",

  "notify.agents.title": "Falcon agents",
  "notify.agents.quietBody": "{count} agents reported during quiet hours: {names}.",
  "notify.agents.digestTitle": "Falcon agents: daily digest",
  "notify.agents.digestBody": "{count} agents reported since the last digest: {names}.",

  "notify.test.body": "Notifications are working. This is what a Falcon alert looks like.",
  "notify.test.unsupported": "This system has no notification service Falcon can use.",
  "notify.test.refused": "The system refused it.",
  "notify.systemSettingsMissing": "This system has no settings page Falcon can open.",

  "notify.source.notRunning": "Not running on this install.",
  "notify.source.marketEvents":
    "Market event alerts are produced by the engine service, which does not send them to the app yet.",
  "notify.source.updates": "Updates are checked only in the installed app.",
  "notify.source.signalsHidden": "Second-order signals are not shown in the app yet, so there is nothing to send.",

  "dialog.export.title": "Export my data",
  "dialog.dataFolder.title": "Choose a folder for Falcon's data",
  "dialog.dataFolder.button": "Use this folder",
  "dialog.accountDeleted.title": "Your account was deleted",
  "dialog.accountDeleted.snaptrade": "Falcon could not reach SnapTrade to remove your brokerage link. It will keep trying.",
  "dialog.accountDeleted.engineRetry": "Falcon could not remove your risk data from its engine yet. It will keep trying.",
  "dialog.accountDeleted.engineManual": "Falcon could not remove your risk data from its engine automatically. Write to the privacy address in the Privacy Policy and it will be removed by hand.",
  "dialog.accountDeleted.local": "Some files of this account on this computer could not be removed. Falcon will try again the next time it starts.",
  "dialog.accountDeleted.ok": "OK",

  "tray.open": "Open Falcon",
  "tray.quit": "Quit Falcon",
  "window.themeEditor.title": "Dark theme colors",

  "update.feedHttp": "HTTP {status} from the release feed",
  "update.feedNoVersion": "The release feed had no version",

  "agents.model.credentials": "The model rejected the credentials. Check the Claude API key or sign in again.",
  "agents.model.unavailable": "The model {model} is not available on this route.",
  "agents.model.busy": "The model is busy right now. Try again shortly.",
  "agents.model.service": "The model service had an error. Try again shortly.",
  "agents.model.rejected": "The model service turned this request down (HTTP {status}).",
  "agents.model.length": "The model's answer ran past its length limit.",
  "agents.model.declined": "The model declined to answer this one.",
  "agents.model.timeout": "The model did not answer in time.",
  "agents.model.notConfigured": "The model is not configured.",
  "agents.model.network": "The model could not be reached. Check the connection and try again.",
  "agents.model.malformed": "The model service sent back a reply that could not be read.",
  "agents.model.failed": "The model call failed for an unexpected reason.",
} satisfies Record<string, string>;

export type MainMessageKey = keyof typeof en;
type Table = Record<MainMessageKey, string>;

const tr: Table = {
  "notify.update.readyTitle": "Falcon güncellemesi hazır",
  "notify.update.readyBody": "{version} sürümü indirildi. Yüklemek için Falcon'u yeniden başlatın.",
  "notify.update.availableTitle": "Falcon'un yeni bir sürümü var",
  "notify.update.availableBody": "{version} sürümü yayımlandı. Güncellemek için indirin.",
  "notify.events.titleOne": "Falcon: yeni piyasa olayı",
  "notify.events.titleOther": "Falcon: {count} yeni piyasa olayı",
  "notify.more": "+{count} daha",
  "notify.signals.title": "İkinci derece sinyal: {ticker}",
  "notify.signals.reachesOne": "Henüz fiyatlanmamış {count} isme ulaşıyor.",
  "notify.signals.reachesOther": "Henüz fiyatlanmamış {count} isme ulaşıyor.",
  "notify.signals.openOne": "{count} açık isim",
  "notify.signals.openOther": "{count} açık isim",
  "notify.signals.batchTitle": "{count} yeni ikinci derece sinyal",
  "notify.agents.title": "Falcon ajanları",
  "notify.agents.quietBody": "Sessiz saatlerde {count} ajan rapor verdi: {names}.",
  "notify.agents.digestTitle": "Falcon ajanları: günlük özet",
  "notify.agents.digestBody": "Son özetten bu yana {count} ajan rapor verdi: {names}.",
  "notify.test.body": "Bildirimler çalışıyor. Falcon uyarıları böyle görünür.",
  "notify.test.unsupported": "Bu sistemde Falcon'un kullanabileceği bir bildirim hizmeti yok.",
  "notify.test.refused": "Sistem bildirimi reddetti.",
  "notify.systemSettingsMissing": "Bu sistemde Falcon'un açabileceği bir ayarlar sayfası yok.",
  "notify.source.notRunning": "Bu kurulumda çalışmıyor.",
  "notify.source.marketEvents":
    "Piyasa olayı uyarılarını motor hizmeti üretiyor ve bu uyarılar henüz uygulamaya gönderilmiyor.",
  "notify.source.updates": "Güncellemeler yalnızca yüklü uygulamada denetlenir.",
  "notify.source.signalsHidden": "İkinci derece sinyaller henüz uygulamada gösterilmediği için gönderilecek bir şey yok.",
  "dialog.export.title": "Verilerimi dışa aktar",
  "dialog.dataFolder.title": "Falcon verileri için bir klasör seçin",
  "dialog.dataFolder.button": "Bu klasörü kullan",
  "dialog.accountDeleted.title": "Hesabınız silindi",
  "dialog.accountDeleted.snaptrade": "Falcon, aracı kurum bağlantınızı kaldırmak için SnapTrade'e ulaşamadı. Denemeye devam edecek.",
  "dialog.accountDeleted.engineRetry": "Falcon risk verilerinizi motorundan henüz kaldıramadı. Denemeye devam edecek.",
  "dialog.accountDeleted.engineManual": "Falcon risk verilerinizi motorundan otomatik olarak kaldıramadı. Gizlilik Politikası'ndaki gizlilik adresine yazın, verileriniz elle kaldırılsın.",
  "dialog.accountDeleted.local": "Bu hesabın bu bilgisayardaki bazı dosyaları kaldırılamadı. Falcon bir sonraki açılışta yeniden deneyecek.",
  "dialog.accountDeleted.ok": "Tamam",

  "tray.open": "Falcon'u aç",
  "tray.quit": "Falcon'dan çık",
  "window.themeEditor.title": "Koyu tema renkleri",
  "update.feedHttp": "Sürüm akışı HTTP {status} döndürdü",
  "update.feedNoVersion": "Sürüm akışında sürüm bilgisi yoktu",

  "agents.model.credentials": "Model kimlik bilgilerini reddetti. Claude API anahtarını kontrol edin ya da yeniden oturum açın.",
  "agents.model.unavailable": "{model} modeli bu yolda kullanılamıyor.",
  "agents.model.busy": "Model şu anda meşgul. Biraz sonra yeniden deneyin.",
  "agents.model.service": "Model hizmetinde bir hata oluştu. Biraz sonra yeniden deneyin.",
  "agents.model.rejected": "Model hizmeti bu isteği geri çevirdi (HTTP {status}).",
  "agents.model.length": "Modelin yanıtı uzunluk sınırını aştı.",
  "agents.model.declined": "Model bu soruyu yanıtlamayı reddetti.",
  "agents.model.timeout": "Model zamanında yanıt vermedi.",
  "agents.model.notConfigured": "Model yapılandırılmamış.",
  "agents.model.network": "Modele ulaşılamadı. Bağlantıyı kontrol edip yeniden deneyin.",
  "agents.model.malformed": "Model hizmeti okunamayan bir yanıt gönderdi.",
  "agents.model.failed": "Model çağrısı beklenmedik bir nedenle başarısız oldu.",
};

const de: Table = {
  "notify.update.readyTitle": "Falcon-Update bereit",
  "notify.update.readyBody": "Version {version} wurde heruntergeladen. Starten Sie Falcon neu, um sie zu installieren.",
  "notify.update.availableTitle": "Eine neuere Version von Falcon ist verfügbar",
  "notify.update.availableBody": "Version {version} ist erschienen. Laden Sie sie herunter, um zu aktualisieren.",
  "notify.events.titleOne": "Falcon: neues Marktereignis",
  "notify.events.titleOther": "Falcon: {count} neue Marktereignisse",
  "notify.more": "+{count} weitere",
  "notify.signals.title": "Signal zweiter Ordnung: {ticker}",
  "notify.signals.reachesOne": "Erreicht {count} Namen, der noch nicht eingepreist ist.",
  "notify.signals.reachesOther": "Erreicht {count} Namen, die noch nicht eingepreist sind.",
  "notify.signals.openOne": "{count} offener Name",
  "notify.signals.openOther": "{count} offene Namen",
  "notify.signals.batchTitle": "{count} neue Signale zweiter Ordnung",
  "notify.agents.title": "Falcon-Agenten",
  "notify.agents.quietBody": "{count} Agenten haben während der Ruhezeit berichtet: {names}.",
  "notify.agents.digestTitle": "Falcon-Agenten: Tagesübersicht",
  "notify.agents.digestBody": "{count} Agenten haben seit der letzten Übersicht berichtet: {names}.",
  "notify.test.body": "Benachrichtigungen funktionieren. So sieht eine Falcon-Meldung aus.",
  "notify.test.unsupported": "Dieses System hat keinen Benachrichtigungsdienst, den Falcon nutzen kann.",
  "notify.test.refused": "Das System hat sie abgelehnt.",
  "notify.systemSettingsMissing": "Dieses System hat keine Einstellungsseite, die Falcon öffnen kann.",
  "notify.source.notRunning": "Auf dieser Installation nicht aktiv.",
  "notify.source.marketEvents":
    "Meldungen zu Marktereignissen erzeugt der Engine-Dienst, der sie noch nicht an die App sendet.",
  "notify.source.updates": "Updates werden nur in der installierten App geprüft.",
  "notify.source.signalsHidden":
    "Signale zweiter Ordnung werden in der App noch nicht angezeigt, daher gibt es nichts zu senden.",
  "dialog.export.title": "Meine Daten exportieren",
  "dialog.dataFolder.title": "Ordner für die Falcon-Daten wählen",
  "dialog.dataFolder.button": "Diesen Ordner verwenden",
  "dialog.accountDeleted.title": "Ihr Konto wurde gelöscht",
  "dialog.accountDeleted.snaptrade": "Falcon konnte SnapTrade nicht erreichen, um Ihre Brokerverbindung zu entfernen. Es versucht es weiter.",
  "dialog.accountDeleted.engineRetry": "Falcon konnte Ihre Risikodaten noch nicht von seiner Engine entfernen. Es versucht es weiter.",
  "dialog.accountDeleted.engineManual": "Falcon konnte Ihre Risikodaten nicht automatisch von seiner Engine entfernen. Schreiben Sie an die Datenschutzadresse in der Datenschutzerklärung, dann werden sie von Hand entfernt.",
  "dialog.accountDeleted.local": "Einige Dateien dieses Kontos auf diesem Computer konnten nicht entfernt werden. Falcon versucht es beim nächsten Start erneut.",
  "dialog.accountDeleted.ok": "OK",

  "tray.open": "Falcon öffnen",
  "tray.quit": "Falcon beenden",
  "window.themeEditor.title": "Farben des dunklen Designs",
  "update.feedHttp": "HTTP {status} vom Release-Feed",
  "update.feedNoVersion": "Der Release-Feed enthielt keine Version",

  "agents.model.credentials": "Das Modell hat die Zugangsdaten abgelehnt. Prüfen Sie den Claude-API-Schlüssel oder melden Sie sich erneut an.",
  "agents.model.unavailable": "Das Modell {model} ist auf diesem Weg nicht verfügbar.",
  "agents.model.busy": "Das Modell ist gerade ausgelastet. Versuchen Sie es gleich noch einmal.",
  "agents.model.service": "Beim Modelldienst ist ein Fehler aufgetreten. Versuchen Sie es gleich noch einmal.",
  "agents.model.rejected": "Der Modelldienst hat diese Anfrage abgelehnt (HTTP {status}).",
  "agents.model.length": "Die Antwort des Modells hat ihre Längengrenze überschritten.",
  "agents.model.declined": "Das Modell hat es abgelehnt, darauf zu antworten.",
  "agents.model.timeout": "Das Modell hat nicht rechtzeitig geantwortet.",
  "agents.model.notConfigured": "Das Modell ist nicht eingerichtet.",
  "agents.model.network": "Das Modell war nicht erreichbar. Prüfen Sie die Verbindung und versuchen Sie es erneut.",
  "agents.model.malformed": "Der Modelldienst hat eine Antwort geschickt, die nicht gelesen werden konnte.",
  "agents.model.failed": "Der Modellaufruf ist aus einem unerwarteten Grund fehlgeschlagen.",
};

const fr: Table = {
  "notify.update.readyTitle": "Mise à jour de Falcon prête",
  "notify.update.readyBody": "La version {version} est téléchargée. Redémarrez Falcon pour l'installer.",
  "notify.update.availableTitle": "Une nouvelle version de Falcon est disponible",
  "notify.update.availableBody": "La version {version} est sortie. Téléchargez-la pour mettre à jour.",
  "notify.events.titleOne": "Falcon : nouvel événement de marché",
  "notify.events.titleOther": "Falcon : {count} nouveaux événements de marché",
  "notify.more": "+{count} de plus",
  "notify.signals.title": "Signal de second ordre : {ticker}",
  "notify.signals.reachesOne": "Atteint {count} nom pas encore intégré dans les cours.",
  "notify.signals.reachesOther": "Atteint {count} noms pas encore intégrés dans les cours.",
  "notify.signals.openOne": "{count} nom ouvert",
  "notify.signals.openOther": "{count} noms ouverts",
  "notify.signals.batchTitle": "{count} nouveaux signaux de second ordre",
  "notify.agents.title": "Agents Falcon",
  "notify.agents.quietBody": "{count} agents ont publié un rapport pendant la période de silence : {names}.",
  "notify.agents.digestTitle": "Agents Falcon : résumé du jour",
  "notify.agents.digestBody": "{count} agents ont publié un rapport depuis le dernier résumé : {names}.",
  "notify.test.body": "Les notifications fonctionnent. Voici à quoi ressemble une alerte Falcon.",
  "notify.test.unsupported": "Ce système n'a aucun service de notification utilisable par Falcon.",
  "notify.test.refused": "Le système l'a refusée.",
  "notify.systemSettingsMissing": "Ce système n'a aucune page de réglages que Falcon puisse ouvrir.",
  "notify.source.notRunning": "Inactif sur cette installation.",
  "notify.source.marketEvents":
    "Les alertes d'événements de marché sont produites par le service moteur, qui ne les envoie pas encore à l'application.",
  "notify.source.updates": "Les mises à jour ne sont vérifiées que dans l'application installée.",
  "notify.source.signalsHidden":
    "Les signaux de second ordre ne sont pas encore affichés dans l'application, il n'y a donc rien à envoyer.",
  "dialog.export.title": "Exporter mes données",
  "dialog.dataFolder.title": "Choisir un dossier pour les données de Falcon",
  "dialog.dataFolder.button": "Utiliser ce dossier",
  "dialog.accountDeleted.title": "Votre compte a été supprimé",
  "dialog.accountDeleted.snaptrade": "Falcon n'a pas pu joindre SnapTrade pour retirer votre lien de courtage. Il va continuer d'essayer.",
  "dialog.accountDeleted.engineRetry": "Falcon n'a pas encore pu retirer vos données de risque de son moteur. Il va continuer d'essayer.",
  "dialog.accountDeleted.engineManual": "Falcon n'a pas pu retirer automatiquement vos données de risque de son moteur. Écrivez à l'adresse de confidentialité indiquée dans la Politique de confidentialité et elles seront retirées à la main.",
  "dialog.accountDeleted.local": "Certains fichiers de ce compte sur cet ordinateur n'ont pas pu être supprimés. Falcon réessaiera au prochain démarrage.",
  "dialog.accountDeleted.ok": "OK",

  "tray.open": "Ouvrir Falcon",
  "tray.quit": "Quitter Falcon",
  "window.themeEditor.title": "Couleurs du thème sombre",
  "update.feedHttp": "HTTP {status} renvoyé par le flux des versions",
  "update.feedNoVersion": "Le flux des versions ne contenait aucune version",

  "agents.model.credentials": "Le modèle a refusé les identifiants. Vérifiez la clé de l'API Claude ou reconnectez-vous.",
  "agents.model.unavailable": "Le modèle {model} n'est pas disponible par cette voie.",
  "agents.model.busy": "Le modèle est occupé pour le moment. Réessayez dans un instant.",
  "agents.model.service": "Le service du modèle a rencontré une erreur. Réessayez dans un instant.",
  "agents.model.rejected": "Le service du modèle a refusé cette requête (HTTP {status}).",
  "agents.model.length": "La réponse du modèle a dépassé sa limite de longueur.",
  "agents.model.declined": "Le modèle a refusé de répondre à cette question.",
  "agents.model.timeout": "Le modèle n'a pas répondu à temps.",
  "agents.model.notConfigured": "Le modèle n'est pas configuré.",
  "agents.model.network": "Impossible de joindre le modèle. Vérifiez la connexion et réessayez.",
  "agents.model.malformed": "Le service du modèle a renvoyé une réponse illisible.",
  "agents.model.failed": "L'appel au modèle a échoué pour une raison inattendue.",
};

const es: Table = {
  "notify.update.readyTitle": "Actualización de Falcon lista",
  "notify.update.readyBody": "La versión {version} se ha descargado. Reinicie Falcon para instalarla.",
  "notify.update.availableTitle": "Hay una versión más reciente de Falcon",
  "notify.update.availableBody": "Ya está disponible la versión {version}. Descárguela para actualizar.",
  "notify.events.titleOne": "Falcon: nuevo evento de mercado",
  "notify.events.titleOther": "Falcon: {count} nuevos eventos de mercado",
  "notify.more": "+{count} más",
  "notify.signals.title": "Señal de segundo orden: {ticker}",
  "notify.signals.reachesOne": "Alcanza {count} nombre que aún no está descontado en el precio.",
  "notify.signals.reachesOther": "Alcanza {count} nombres que aún no están descontados en el precio.",
  "notify.signals.openOne": "{count} nombre abierto",
  "notify.signals.openOther": "{count} nombres abiertos",
  "notify.signals.batchTitle": "{count} nuevas señales de segundo orden",
  "notify.agents.title": "Agentes de Falcon",
  "notify.agents.quietBody": "{count} agentes informaron durante las horas de silencio: {names}.",
  "notify.agents.digestTitle": "Agentes de Falcon: resumen diario",
  "notify.agents.digestBody": "{count} agentes informaron desde el último resumen: {names}.",
  "notify.test.body": "Las notificaciones funcionan. Así se ve una alerta de Falcon.",
  "notify.test.unsupported": "Este sistema no tiene un servicio de notificaciones que Falcon pueda usar.",
  "notify.test.refused": "El sistema la rechazó.",
  "notify.systemSettingsMissing": "Este sistema no tiene una página de ajustes que Falcon pueda abrir.",
  "notify.source.notRunning": "No se ejecuta en esta instalación.",
  "notify.source.marketEvents":
    "Las alertas de eventos de mercado las genera el servicio del motor, que aún no las envía a la aplicación.",
  "notify.source.updates": "Las actualizaciones solo se comprueban en la aplicación instalada.",
  "notify.source.signalsHidden":
    "Las señales de segundo orden aún no se muestran en la aplicación, así que no hay nada que enviar.",
  "dialog.export.title": "Exportar mis datos",
  "dialog.dataFolder.title": "Elegir una carpeta para los datos de Falcon",
  "dialog.dataFolder.button": "Usar esta carpeta",
  "dialog.accountDeleted.title": "Tu cuenta se ha eliminado",
  "dialog.accountDeleted.snaptrade": "Falcon no pudo contactar con SnapTrade para quitar tu conexión con el bróker. Seguirá intentándolo.",
  "dialog.accountDeleted.engineRetry": "Falcon aún no pudo quitar tus datos de riesgo de su motor. Seguirá intentándolo.",
  "dialog.accountDeleted.engineManual": "Falcon no pudo quitar automáticamente tus datos de riesgo de su motor. Escribe a la dirección de privacidad de la Política de privacidad y se quitarán a mano.",
  "dialog.accountDeleted.local": "No se pudieron quitar algunos archivos de esta cuenta en este ordenador. Falcon lo intentará de nuevo la próxima vez que se inicie.",
  "dialog.accountDeleted.ok": "Aceptar",

  "tray.open": "Abrir Falcon",
  "tray.quit": "Salir de Falcon",
  "window.themeEditor.title": "Colores del tema oscuro",
  "update.feedHttp": "HTTP {status} del canal de versiones",
  "update.feedNoVersion": "El canal de versiones no incluía ninguna versión",

  "agents.model.credentials": "El modelo rechazó las credenciales. Revisa la clave de la API de Claude o vuelve a iniciar sesión.",
  "agents.model.unavailable": "El modelo {model} no está disponible por esta vía.",
  "agents.model.busy": "El modelo está ocupado ahora mismo. Vuelve a intentarlo en un momento.",
  "agents.model.service": "El servicio del modelo tuvo un error. Vuelve a intentarlo en un momento.",
  "agents.model.rejected": "El servicio del modelo rechazó esta solicitud (HTTP {status}).",
  "agents.model.length": "La respuesta del modelo superó su límite de longitud.",
  "agents.model.declined": "El modelo se negó a responder a esta pregunta.",
  "agents.model.timeout": "El modelo no respondió a tiempo.",
  "agents.model.notConfigured": "El modelo no está configurado.",
  "agents.model.network": "No se pudo contactar con el modelo. Revisa la conexión y vuelve a intentarlo.",
  "agents.model.malformed": "El servicio del modelo devolvió una respuesta que no se pudo leer.",
  "agents.model.failed": "La llamada al modelo falló por un motivo inesperado.",
};

const it: Table = {
  "notify.update.readyTitle": "Aggiornamento di Falcon pronto",
  "notify.update.readyBody": "La versione {version} è stata scaricata. Riavvia Falcon per installarla.",
  "notify.update.availableTitle": "È disponibile una versione più recente di Falcon",
  "notify.update.availableBody": "È uscita la versione {version}. Scaricala per aggiornare.",
  "notify.events.titleOne": "Falcon: nuovo evento di mercato",
  "notify.events.titleOther": "Falcon: {count} nuovi eventi di mercato",
  "notify.more": "+{count} altri",
  "notify.signals.title": "Segnale di secondo ordine: {ticker}",
  "notify.signals.reachesOne": "Raggiunge {count} nome non ancora prezzato.",
  "notify.signals.reachesOther": "Raggiunge {count} nomi non ancora prezzati.",
  "notify.signals.openOne": "{count} nome aperto",
  "notify.signals.openOther": "{count} nomi aperti",
  "notify.signals.batchTitle": "{count} nuovi segnali di secondo ordine",
  "notify.agents.title": "Agenti Falcon",
  "notify.agents.quietBody": "{count} agenti hanno inviato un report durante le ore di silenzio: {names}.",
  "notify.agents.digestTitle": "Agenti Falcon: riepilogo giornaliero",
  "notify.agents.digestBody": "{count} agenti hanno inviato un report dall'ultimo riepilogo: {names}.",
  "notify.test.body": "Le notifiche funzionano. Ecco come appare un avviso di Falcon.",
  "notify.test.unsupported": "Questo sistema non ha un servizio di notifiche utilizzabile da Falcon.",
  "notify.test.refused": "Il sistema l'ha rifiutata.",
  "notify.systemSettingsMissing": "Questo sistema non ha una pagina di impostazioni che Falcon possa aprire.",
  "notify.source.notRunning": "Non attivo su questa installazione.",
  "notify.source.marketEvents":
    "Gli avvisi sugli eventi di mercato sono prodotti dal servizio del motore, che non li invia ancora all'app.",
  "notify.source.updates": "Gli aggiornamenti vengono controllati solo nell'app installata.",
  "notify.source.signalsHidden":
    "I segnali di secondo ordine non sono ancora mostrati nell'app, quindi non c'è nulla da inviare.",
  "dialog.export.title": "Esporta i miei dati",
  "dialog.dataFolder.title": "Scegli una cartella per i dati di Falcon",
  "dialog.dataFolder.button": "Usa questa cartella",
  "dialog.accountDeleted.title": "Il tuo account è stato eliminato",
  "dialog.accountDeleted.snaptrade": "Falcon non è riuscito a raggiungere SnapTrade per rimuovere il collegamento al broker. Continuerà a provare.",
  "dialog.accountDeleted.engineRetry": "Falcon non è ancora riuscito a rimuovere i tuoi dati di rischio dal suo motore. Continuerà a provare.",
  "dialog.accountDeleted.engineManual": "Falcon non è riuscito a rimuovere automaticamente i tuoi dati di rischio dal suo motore. Scrivi all'indirizzo per la privacy indicato nell'Informativa sulla privacy e verranno rimossi a mano.",
  "dialog.accountDeleted.local": "Alcuni file di questo account su questo computer non sono stati rimossi. Falcon riproverà al prossimo avvio.",
  "dialog.accountDeleted.ok": "OK",

  "tray.open": "Apri Falcon",
  "tray.quit": "Esci da Falcon",
  "window.themeEditor.title": "Colori del tema scuro",
  "update.feedHttp": "HTTP {status} dal feed delle versioni",
  "update.feedNoVersion": "Il feed delle versioni non conteneva alcuna versione",

  "agents.model.credentials": "Il modello ha rifiutato le credenziali. Controlla la chiave API di Claude o accedi di nuovo.",
  "agents.model.unavailable": "Il modello {model} non è disponibile su questo percorso.",
  "agents.model.busy": "Il modello è occupato in questo momento. Riprova tra poco.",
  "agents.model.service": "Il servizio del modello ha avuto un errore. Riprova tra poco.",
  "agents.model.rejected": "Il servizio del modello ha rifiutato questa richiesta (HTTP {status}).",
  "agents.model.length": "La risposta del modello ha superato il limite di lunghezza.",
  "agents.model.declined": "Il modello ha rifiutato di rispondere a questa domanda.",
  "agents.model.timeout": "Il modello non ha risposto in tempo.",
  "agents.model.notConfigured": "Il modello non è configurato.",
  "agents.model.network": "Impossibile raggiungere il modello. Controlla la connessione e riprova.",
  "agents.model.malformed": "Il servizio del modello ha restituito una risposta illeggibile.",
  "agents.model.failed": "La chiamata al modello non è riuscita per un motivo imprevisto.",
};

const ptBR: Table = {
  "notify.update.readyTitle": "Atualização do Falcon pronta",
  "notify.update.readyBody": "A versão {version} foi baixada. Reinicie o Falcon para instalá-la.",
  "notify.update.availableTitle": "Há uma versão mais recente do Falcon",
  "notify.update.availableBody": "A versão {version} foi lançada. Baixe-a para atualizar.",
  "notify.events.titleOne": "Falcon: novo evento de mercado",
  "notify.events.titleOther": "Falcon: {count} novos eventos de mercado",
  "notify.more": "+{count} outros",
  "notify.signals.title": "Sinal de segunda ordem: {ticker}",
  "notify.signals.reachesOne": "Alcança {count} nome ainda não precificado.",
  "notify.signals.reachesOther": "Alcança {count} nomes ainda não precificados.",
  "notify.signals.openOne": "{count} nome em aberto",
  "notify.signals.openOther": "{count} nomes em aberto",
  "notify.signals.batchTitle": "{count} novos sinais de segunda ordem",
  "notify.agents.title": "Agentes do Falcon",
  "notify.agents.quietBody": "{count} agentes enviaram relatórios durante o horário silencioso: {names}.",
  "notify.agents.digestTitle": "Agentes Falcon: resumo diário",
  "notify.agents.digestBody": "{count} agentes enviaram relatórios desde o último resumo: {names}.",
  "notify.test.body": "As notificações estão funcionando. É assim que um alerta do Falcon aparece.",
  "notify.test.unsupported": "Este sistema não tem um serviço de notificações que o Falcon possa usar.",
  "notify.test.refused": "O sistema a recusou.",
  "notify.systemSettingsMissing": "Este sistema não tem uma página de configurações que o Falcon possa abrir.",
  "notify.source.notRunning": "Não está em execução nesta instalação.",
  "notify.source.marketEvents":
    "Os alertas de eventos de mercado são gerados pelo serviço do motor, que ainda não os envia ao aplicativo.",
  "notify.source.updates": "As atualizações são verificadas apenas no aplicativo instalado.",
  "notify.source.signalsHidden":
    "Os sinais de segunda ordem ainda não aparecem no aplicativo, então não há nada para enviar.",
  "dialog.export.title": "Exportar meus dados",
  "dialog.dataFolder.title": "Escolher uma pasta para os dados do Falcon",
  "dialog.dataFolder.button": "Usar esta pasta",
  "dialog.accountDeleted.title": "Sua conta foi excluída",
  "dialog.accountDeleted.snaptrade": "O Falcon não conseguiu acessar a SnapTrade para remover sua conexão com a corretora. Ele vai continuar tentando.",
  "dialog.accountDeleted.engineRetry": "O Falcon ainda não conseguiu remover seus dados de risco do motor. Ele vai continuar tentando.",
  "dialog.accountDeleted.engineManual": "O Falcon não conseguiu remover automaticamente seus dados de risco do motor. Escreva para o endereço de privacidade da Política de Privacidade e eles serão removidos manualmente.",
  "dialog.accountDeleted.local": "Alguns arquivos desta conta neste computador não puderam ser removidos. O Falcon vai tentar de novo na próxima vez que abrir.",
  "dialog.accountDeleted.ok": "OK",

  "tray.open": "Abrir o Falcon",
  "tray.quit": "Sair do Falcon",
  "window.themeEditor.title": "Cores do tema escuro",
  "update.feedHttp": "HTTP {status} do feed de versões",
  "update.feedNoVersion": "O feed de versões não continha nenhuma versão",

  "agents.model.credentials": "O modelo recusou as credenciais. Verifique a chave da API do Claude ou entre novamente.",
  "agents.model.unavailable": "O modelo {model} não está disponível por esta rota.",
  "agents.model.busy": "O modelo está ocupado agora. Tente de novo em instantes.",
  "agents.model.service": "O serviço do modelo teve um erro. Tente de novo em instantes.",
  "agents.model.rejected": "O serviço do modelo recusou esta solicitação (HTTP {status}).",
  "agents.model.length": "A resposta do modelo passou do limite de tamanho.",
  "agents.model.declined": "O modelo se recusou a responder a esta pergunta.",
  "agents.model.timeout": "O modelo não respondeu a tempo.",
  "agents.model.notConfigured": "O modelo não está configurado.",
  "agents.model.network": "Não foi possível alcançar o modelo. Verifique a conexão e tente de novo.",
  "agents.model.malformed": "O serviço do modelo devolveu uma resposta que não pôde ser lida.",
  "agents.model.failed": "A chamada ao modelo falhou por um motivo inesperado.",
};

const ja: Table = {
  "notify.update.readyTitle": "Falconのアップデートの準備ができました",
  "notify.update.readyBody": "バージョン{version}をダウンロードしました。インストールするにはFalconを再起動してください。",
  "notify.update.availableTitle": "Falconの新しいバージョンがあります",
  "notify.update.availableBody": "バージョン{version}が公開されました。ダウンロードして更新してください。",
  "notify.events.titleOne": "Falcon：新しい市場イベント",
  "notify.events.titleOther": "Falcon：{count}件の新しい市場イベント",
  "notify.more": "ほか{count}件",
  "notify.signals.title": "二次シグナル：{ticker}",
  "notify.signals.reachesOne": "まだ織り込まれていない{count}銘柄に波及します。",
  "notify.signals.reachesOther": "まだ織り込まれていない{count}銘柄に波及します。",
  "notify.signals.openOne": "未織り込み{count}銘柄",
  "notify.signals.openOther": "未織り込み{count}銘柄",
  "notify.signals.batchTitle": "{count}件の新しい二次シグナル",
  "notify.agents.title": "Falconエージェント",
  "notify.agents.quietBody": "通知停止時間中に{count}件のエージェントがレポートしました：{names}。",
  "notify.agents.digestTitle": "Falcon エージェント：デイリーまとめ",
  "notify.agents.digestBody": "前回のまとめ以降に{count}件のエージェントがレポートしました：{names}。",
  "notify.test.body": "通知は正常に動作しています。Falconのアラートはこのように表示されます。",
  "notify.test.unsupported": "このシステムにはFalconが利用できる通知サービスがありません。",
  "notify.test.refused": "システムによって拒否されました。",
  "notify.systemSettingsMissing": "このシステムにはFalconが開ける設定ページがありません。",
  "notify.source.notRunning": "このインストールでは実行されていません。",
  "notify.source.marketEvents": "市場イベントのアラートはエンジンサービスが生成していますが、まだアプリには送信されません。",
  "notify.source.updates": "アップデートはインストール版のアプリでのみ確認されます。",
  "notify.source.signalsHidden": "二次シグナルはまだアプリに表示されないため、送信するものはありません。",
  "dialog.export.title": "データを書き出す",
  "dialog.dataFolder.title": "Falcon のデータを保存するフォルダを選択",
  "dialog.dataFolder.button": "このフォルダを使用",
  "dialog.accountDeleted.title": "アカウントを削除しました",
  "dialog.accountDeleted.snaptrade": "証券会社の連携を削除するために SnapTrade に接続できませんでした。Falcon は再試行を続けます。",
  "dialog.accountDeleted.engineRetry": "エンジン上のリスクデータをまだ削除できていません。Falcon は再試行を続けます。",
  "dialog.accountDeleted.engineManual": "エンジン上のリスクデータを自動で削除できませんでした。プライバシーポリシーに記載のプライバシー窓口へご連絡いただければ、手作業で削除します。",
  "dialog.accountDeleted.local": "このコンピュータ上のこのアカウントのファイルの一部を削除できませんでした。Falcon は次回の起動時に再試行します。",
  "dialog.accountDeleted.ok": "OK",

  "tray.open": "Falcon を開く",
  "tray.quit": "Falcon を終了",
  "window.themeEditor.title": "ダークテーマの色",
  "update.feedHttp": "リリースフィードからHTTP {status}が返されました",
  "update.feedNoVersion": "リリースフィードにバージョンがありませんでした",

  "agents.model.credentials": "モデルが認証情報を拒否しました。Claude API キーを確認するか、もう一度サインインしてください。",
  "agents.model.unavailable": "モデル {model} はこの経路では利用できません。",
  "agents.model.busy": "モデルは現在混み合っています。しばらくしてからもう一度お試しください。",
  "agents.model.service": "モデルのサービスでエラーが発生しました。しばらくしてからもう一度お試しください。",
  "agents.model.rejected": "モデルのサービスがこのリクエストを受け付けませんでした（HTTP {status}）。",
  "agents.model.length": "モデルの回答が長さの上限を超えました。",
  "agents.model.declined": "モデルはこの質問への回答を断りました。",
  "agents.model.timeout": "モデルが時間内に応答しませんでした。",
  "agents.model.notConfigured": "モデルが設定されていません。",
  "agents.model.network": "モデルに接続できませんでした。接続を確認して、もう一度お試しください。",
  "agents.model.malformed": "モデルのサービスから読み取れない応答が返されました。",
  "agents.model.failed": "予期しない理由でモデルの呼び出しに失敗しました。",
};

const zhCN: Table = {
  "notify.update.readyTitle": "Falcon 更新已就绪",
  "notify.update.readyBody": "版本 {version} 已下载。重新启动 Falcon 即可安装。",
  "notify.update.availableTitle": "Falcon 有新版本可用",
  "notify.update.availableBody": "版本 {version} 已发布。请下载以更新。",
  "notify.events.titleOne": "Falcon：新的市场事件",
  "notify.events.titleOther": "Falcon：{count} 个新的市场事件",
  "notify.more": "另外 {count} 条",
  "notify.signals.title": "二阶信号：{ticker}",
  "notify.signals.reachesOne": "波及 {count} 个尚未计入价格的标的。",
  "notify.signals.reachesOther": "波及 {count} 个尚未计入价格的标的。",
  "notify.signals.openOne": "{count} 个尚未定价的标的",
  "notify.signals.openOther": "{count} 个尚未定价的标的",
  "notify.signals.batchTitle": "{count} 个新的二阶信号",
  "notify.agents.title": "Falcon 智能体",
  "notify.agents.quietBody": "免打扰时段内有 {count} 个智能体提交了报告：{names}。",
  "notify.agents.digestTitle": "Falcon 智能体：每日摘要",
  "notify.agents.digestBody": "自上次摘要以来，有 {count} 个智能体提交了报告：{names}。",
  "notify.test.body": "通知功能正常。Falcon 提醒就是这样显示的。",
  "notify.test.unsupported": "此系统没有 Falcon 可用的通知服务。",
  "notify.test.refused": "系统拒绝了该通知。",
  "notify.systemSettingsMissing": "此系统没有 Falcon 可以打开的设置页面。",
  "notify.source.notRunning": "未在此安装中运行。",
  "notify.source.marketEvents": "市场事件提醒由引擎服务生成，该服务尚未将其发送到应用。",
  "notify.source.updates": "仅在已安装的应用中检查更新。",
  "notify.source.signalsHidden": "二阶信号尚未在应用中显示，因此没有可发送的内容。",
  "dialog.export.title": "导出我的数据",
  "dialog.dataFolder.title": "选择存放 Falcon 数据的文件夹",
  "dialog.dataFolder.button": "使用此文件夹",
  "dialog.accountDeleted.title": "你的账户已删除",
  "dialog.accountDeleted.snaptrade": "Falcon 无法连接 SnapTrade 来移除你的券商连接。它会继续重试。",
  "dialog.accountDeleted.engineRetry": "Falcon 暂时无法从引擎中移除你的风险数据。它会继续重试。",
  "dialog.accountDeleted.engineManual": "Falcon 无法自动从引擎中移除你的风险数据。请写信至隐私政策中的隐私联系地址，我们会手动移除。",
  "dialog.accountDeleted.local": "此账户在这台电脑上的部分文件无法移除。Falcon 会在下次启动时重试。",
  "dialog.accountDeleted.ok": "确定",

  "tray.open": "打开 Falcon",
  "tray.quit": "退出 Falcon",
  "window.themeEditor.title": "深色主题颜色",
  "update.feedHttp": "发布源返回 HTTP {status}",
  "update.feedNoVersion": "发布源中没有版本信息",

  "agents.model.credentials": "模型拒绝了凭据。请检查 Claude API 密钥，或重新登录。",
  "agents.model.unavailable": "模型 {model} 在此路由上不可用。",
  "agents.model.busy": "模型当前繁忙。请稍后重试。",
  "agents.model.service": "模型服务出错。请稍后重试。",
  "agents.model.rejected": "模型服务拒绝了此请求（HTTP {status}）。",
  "agents.model.length": "模型的回答超出了长度上限。",
  "agents.model.declined": "模型拒绝回答这个问题。",
  "agents.model.timeout": "模型未能及时响应。",
  "agents.model.notConfigured": "模型尚未配置。",
  "agents.model.network": "无法连接到模型。请检查网络连接后重试。",
  "agents.model.malformed": "模型服务返回了无法读取的回复。",
  "agents.model.failed": "模型调用因意外原因失败。",
};

const ko: Table = {
  "notify.update.readyTitle": "Falcon 업데이트 준비 완료",
  "notify.update.readyBody": "버전 {version}을(를) 다운로드했습니다. 설치하려면 Falcon을 다시 시작하세요.",
  "notify.update.availableTitle": "새 버전의 Falcon을 사용할 수 있습니다",
  "notify.update.availableBody": "버전 {version}이(가) 출시되었습니다. 업데이트하려면 다운로드하세요.",
  "notify.events.titleOne": "Falcon: 새 시장 이벤트",
  "notify.events.titleOther": "Falcon: 새 시장 이벤트 {count}건",
  "notify.more": "외 {count}건",
  "notify.signals.title": "2차 시그널: {ticker}",
  "notify.signals.reachesOne": "아직 가격에 반영되지 않은 종목 {count}개에 영향을 줍니다.",
  "notify.signals.reachesOther": "아직 가격에 반영되지 않은 종목 {count}개에 영향을 줍니다.",
  "notify.signals.openOne": "미반영 종목 {count}개",
  "notify.signals.openOther": "미반영 종목 {count}개",
  "notify.signals.batchTitle": "새 2차 시그널 {count}건",
  "notify.agents.title": "Falcon 에이전트",
  "notify.agents.quietBody": "방해 금지 시간 동안 에이전트 {count}개가 보고했습니다: {names}.",
  "notify.agents.digestTitle": "Falcon 에이전트: 일일 요약",
  "notify.agents.digestBody": "지난 요약 이후 에이전트 {count}개가 보고했습니다: {names}.",
  "notify.test.body": "알림이 정상적으로 작동합니다. Falcon 알림은 이렇게 표시됩니다.",
  "notify.test.unsupported": "이 시스템에는 Falcon이 사용할 수 있는 알림 서비스가 없습니다.",
  "notify.test.refused": "시스템이 알림을 거부했습니다.",
  "notify.systemSettingsMissing": "이 시스템에는 Falcon이 열 수 있는 설정 페이지가 없습니다.",
  "notify.source.notRunning": "이 설치에서는 실행되지 않습니다.",
  "notify.source.marketEvents": "시장 이벤트 알림은 엔진 서비스에서 생성되며, 아직 앱으로 전송되지 않습니다.",
  "notify.source.updates": "업데이트는 설치된 앱에서만 확인합니다.",
  "notify.source.signalsHidden": "2차 시그널이 아직 앱에 표시되지 않으므로 보낼 내용이 없습니다.",
  "dialog.export.title": "내 데이터 내보내기",
  "dialog.dataFolder.title": "Falcon 데이터를 저장할 폴더 선택",
  "dialog.dataFolder.button": "이 폴더 사용",
  "dialog.accountDeleted.title": "계정이 삭제되었습니다",
  "dialog.accountDeleted.snaptrade": "증권사 연결을 제거하기 위해 SnapTrade에 연결하지 못했습니다. Falcon이 계속 다시 시도합니다.",
  "dialog.accountDeleted.engineRetry": "엔진에서 리스크 데이터를 아직 제거하지 못했습니다. Falcon이 계속 다시 시도합니다.",
  "dialog.accountDeleted.engineManual": "엔진에서 리스크 데이터를 자동으로 제거하지 못했습니다. 개인정보처리방침에 있는 개인정보 문의 주소로 연락하시면 직접 제거해 드립니다.",
  "dialog.accountDeleted.local": "이 컴퓨터에 있는 이 계정의 일부 파일을 제거하지 못했습니다. Falcon이 다음 실행 때 다시 시도합니다.",
  "dialog.accountDeleted.ok": "확인",

  "tray.open": "Falcon 열기",
  "tray.quit": "Falcon 종료",
  "window.themeEditor.title": "다크 테마 색상",
  "update.feedHttp": "릴리스 피드에서 HTTP {status} 응답을 받았습니다",
  "update.feedNoVersion": "릴리스 피드에 버전 정보가 없습니다",

  "agents.model.credentials": "모델이 인증 정보를 거부했습니다. Claude API 키를 확인하거나 다시 로그인하세요.",
  "agents.model.unavailable": "모델 {model}은(는) 이 경로에서 사용할 수 없습니다.",
  "agents.model.busy": "모델이 지금 사용량이 많습니다. 잠시 후 다시 시도하세요.",
  "agents.model.service": "모델 서비스에 오류가 발생했습니다. 잠시 후 다시 시도하세요.",
  "agents.model.rejected": "모델 서비스가 이 요청을 거절했습니다(HTTP {status}).",
  "agents.model.length": "모델의 답변이 길이 제한을 넘었습니다.",
  "agents.model.declined": "모델이 이 질문에 대한 답변을 거절했습니다.",
  "agents.model.timeout": "모델이 제때 응답하지 않았습니다.",
  "agents.model.notConfigured": "모델이 설정되어 있지 않습니다.",
  "agents.model.network": "모델에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시도하세요.",
  "agents.model.malformed": "모델 서비스가 읽을 수 없는 응답을 보냈습니다.",
  "agents.model.failed": "예상치 못한 이유로 모델 호출에 실패했습니다.",
};

/** Every language's table. Full tables, so the compiler reports a missing key. */
export const MAIN_MESSAGES: Readonly<Record<MainLanguage, Table>> = {
  "en-US": en,
  "tr-TR": tr,
  "de-DE": de,
  "fr-FR": fr,
  "es-ES": es,
  "it-IT": it,
  "pt-BR": ptBR,
  "ja-JP": ja,
  "zh-CN": zhCN,
  "ko-KR": ko,
};

let chosen: MainLanguage | null = null;
let fallback: () => MainLanguage | null = () => null;

/** What to read until the renderer has said: the machine's language, when it can be known. */
export function setMainLanguageFallback(resolve: () => MainLanguage | null): void {
  fallback = resolve;
}

/** The reader's choice. Anything that is not a language Falcon has is ignored. */
export function setMainLanguage(code: unknown): boolean {
  if (!isMainLanguage(code)) return false;
  chosen = code;
  return true;
}

export function getMainLanguage(): MainLanguage {
  if (chosen) return chosen;
  try {
    return fallback() ?? "en-US";
  } catch {
    return "en-US";
  }
}

export type MainMessageVars = Readonly<Record<string, string | number>>;

/** `key` in the current language, `{name}` filled from `vars`; English when a table lacks it. */
export function mt(key: MainMessageKey, vars?: MainMessageVars, language: MainLanguage = getMainLanguage()): string {
  const template = MAIN_MESSAGES[language]?.[key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/** The one or the other key by the language's plural rule for `count`, with `count` filled in. */
export function mtCount(
  one: MainMessageKey,
  other: MainMessageKey,
  count: number,
  vars: MainMessageVars = {},
  language: MainLanguage = getMainLanguage(),
): string {
  const rule = new Intl.PluralRules(language).select(count);
  return mt(rule === "one" ? one : other, { ...vars, count }, language);
}

/** Names joined the way the language joins a list ("A, B and C", "A、B、C"). */
export function mList(items: readonly string[], language: MainLanguage = getMainLanguage()): string {
  try {
    return new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}
