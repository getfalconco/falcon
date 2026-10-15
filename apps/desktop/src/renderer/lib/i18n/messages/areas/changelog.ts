/**
 * Messages for What's new (components/changelog): the panel's own words and
 * every release note in lib/changelog.ts, in every language. A release line
 * is keyed `changelog.r<YYYYMMDD>.<section><n>`; lib/changelog.ts lists the
 * keys and this file holds the words. English is the source; the other
 * tables are Partial and fall back to English per key. Same rules as
 * messages/en.ts: `{name}` placeholders kept in every language, and no em
 * dash or en dash anywhere (shared/copy-rules.ts).
 */
export const en = {
  "changelog.title": "What's new",
  "changelog.version": "Version {version}",
  "changelog.section.new": "New",
  "changelog.section.improved": "Improved",
  "changelog.section.fixed": "Fixed",
  "changelog.r20261004.new1":
    "Added an Account page to Settings, where you can change your full name and what Falcon calls you. The name you pick is the one the greeting and the account pill use.",
  "changelog.r20261004.new2":
    "Added Log out of all devices to the Account page. It asks for a second press before it signs you out everywhere.",
  "changelog.r20261004.new3":
    "Added two arrows to the Calendar card that step one trading day back or forward, skipping weekends and market holidays. The header names the day you are looking at.",
  "changelog.r20261004.improved1":
    "When one of Falcon's servers is unavailable, the app now says so plainly instead of showing a bare “HTTP 404”.",
  "changelog.r20261004.fixed1":
    "Fixed cards you deleted from the dashboard coming back the next time you opened Falcon.",
  "changelog.r20261003.improved1":
    "Falcon now reaches its servers at permanent addresses of its own, so moving the servers no longer means installing a new version of the app.",
  "changelog.r20261003.fixed1":
    "Fixed news scoring stopping on a freshly set-up server, which left new headlines without a relevance verdict.",
  "changelog.r20260926.new1":
    "Added a dark theme. Choose System, Light or Dark under Settings → General → Appearance. Cards, the search bar and the account pill get their own surfaces on black, so they still stand apart from the page.",
  "changelog.r20260926.new2":
    "Added an Add Module button beside the search bar on the dashboard. It brings back a card you removed, or adds a second copy of one already there, and scrolls straight to it.",
  "changelog.r20260926.new3":
    "Hover over a row on the Calendar card, or move to it with the keyboard, to see more about it: the time in New York and in your own time zone, what the release covers, how much it matters and where its date comes from.",
  "changelog.r20260926.improved1":
    "Moved the account pill to the left of the search bar, so a longer name grows away from the search bar instead of into it.",
  "changelog.r20260926.improved2":
    "Every dashboard dropdown now opens and closes with a simple fade.",
  "changelog.r20260926.improved3":
    "Cards still snap into place as you move or resize them, but the guide lines are no longer drawn over the canvas.",
  "changelog.r20260926.improved4":
    "Removed the handover card from the dashboard. The “while you were away” popup still opens on launch and with Shift+M.",
  "changelog.r20260924.new1":
    "Added a Calendar card with the trading session's schedule: the time of each event, what it covers, and a line showing where the day stands now. The header says whether it shows today, the next session or the last one, along with New York's UTC offset.",
  "changelog.r20260924.new2":
    "Added a News card to the dashboard.",
  "changelog.r20260924.new3":
    "Added a launch briefing. Once per session before the US market opens, a short popup sums up what happened while you were away, with one line each for News, Earnings and Other and a See more for each. Press Shift+M to open it at any time.",
  "changelog.r20260924.new4":
    "Added an account menu to the profile pill, with your email address, Settings and Sign out.",
  "changelog.r20260924.improved1":
    "Widening the Positions card now slides more of the table into view smoothly, instead of adding columns in jumps.",
  "changelog.r20260924.improved2":
    "The Portfolio Value card has a settings panel for picking the chart's timeframe, and comparison lines are no longer drawn behind the chart.",
  "changelog.r20260924.improved3":
    "Cards now snap to each other's sides and sizes as you move and resize them.",
  "changelog.r20260924.improved4":
    "The launch briefing respects privacy mode and hides dollar amounts.",
  "changelog.r20260921.new1":
    "Your dashboard is now a free canvas: drag cards anywhere, let them overlap, and the card you touch comes to the front. A layout keeps its proportions when you move from a large monitor to a laptop.",
  "changelog.r20260921.new2":
    "Added beta, exposure, reach, volatility, momentum and 52-week columns to the Positions card. A beta the market barely explains is drawn faint and says so when you hover over it.",
  "changelog.r20260921.new3":
    "Portfolio Value is now a regular card with the same menu as every other card.",
  "changelog.r20260921.improved1":
    "Positions now has one pinned column header for the whole list instead of one per group.",
  "changelog.r20260921.improved2":
    "The line under your P&L now says which holdings carry your gains or losses, and how much of them.",
  "changelog.r20260921.improved3":
    "Cash is shown by currency with its flag, and ETFs have a group of their own in Positions.",
  "changelog.r20260921.fixed1":
    "Fixed holdings, ETFs in particular, never getting a beta because they were added to a tracker the dashboard did not read.",
  "changelog.r20260921.fixed2":
    "Fixed live dashboard data failing to load after a server crash. The server now stays up through errors and recovers on its own.",
  "changelog.r20260921.fixed3":
    "Fixed the server restarting every minute or two as its memory ran out, which kept interrupting live data.",
  "changelog.r20260916.new1":
    "Introducing Falcon: relationship graphs built from companies' SEC filings, news followed as it spreads across those relationships into second-order signals, and a read on whether the market has already priced the move in.",
} satisfies Record<string, string>;

type Table = Partial<Record<keyof typeof en, string>>;

export const tr: Table = {
  "changelog.title": "Yenilikler",
  "changelog.version": "Sürüm {version}",
  "changelog.section.new": "Yeni",
  "changelog.section.improved": "İyileştirildi",
  "changelog.section.fixed": "Düzeltildi",
  "changelog.r20261004.new1":
    "Ayarlar'a bir Hesap sayfası eklendi; burada tam adınızı ve Falcon'un size nasıl hitap edeceğini değiştirebilirsiniz. Seçtiğiniz ad, karşılama mesajında ve hesap düğmesinde kullanılır.",
  "changelog.r20261004.new2":
    "Hesap sayfasına Tüm cihazlardan çıkış yap seçeneği eklendi. Sizi her yerden çıkarmadan önce ikinci bir onay ister.",
  "changelog.r20261004.new3":
    "Takvim kartına, hafta sonlarını ve piyasa tatillerini atlayarak bir işlem günü geri veya ileri giden iki ok eklendi. Başlık, baktığınız günü gösterir.",
  "changelog.r20261004.improved1":
    "Falcon'un sunucularından biri kullanılamadığında uygulama artık yalnızca “HTTP 404” göstermek yerine bunu açıkça söylüyor.",
  "changelog.r20261004.fixed1":
    "Panodan sildiğiniz kartların Falcon'u bir sonraki açışınızda geri gelmesi düzeltildi.",
  "changelog.r20261003.improved1":
    "Falcon artık sunucularına kendine ait kalıcı adreslerden ulaşıyor; sunucuların taşınması artık uygulamanın yeni bir sürümünü yüklemeyi gerektirmiyor.",
  "changelog.r20261003.fixed1":
    "Yeni kurulmuş bir sunucuda haber puanlamasının durması ve yeni başlıkların ilgi kararı almadan kalması düzeltildi.",
  "changelog.r20260926.new1":
    "Koyu tema eklendi. Ayarlar → Genel → Görünüm altından Sistem, Açık veya Koyu seçin. Kartlar, arama çubuğu ve hesap düğmesi siyah üzerinde kendi yüzeylerini alır, böylece sayfadan ayrı durmaya devam ederler.",
  "changelog.r20260926.new2":
    "Panoda arama çubuğunun yanına Modül Ekle düğmesi eklendi. Kaldırdığınız bir kartı geri getirir veya mevcut bir kartın ikinci kopyasını ekler ve doğrudan ona kaydırır.",
  "changelog.r20260926.new3":
    "Takvim kartındaki bir satırın üzerine gelin veya klavyeyle ona gidin; daha fazlasını görün: New York saati ve kendi saat diliminizdeki saat, verinin neyi kapsadığı, ne kadar önemli olduğu ve tarihinin nereden geldiği.",
  "changelog.r20260926.improved1":
    "Hesap düğmesi arama çubuğunun soluna taşındı; böylece uzun bir ad arama çubuğuna doğru değil, ondan uzağa doğru uzar.",
  "changelog.r20260926.improved2":
    "Panodaki tüm açılır menüler artık sade bir geçişle açılıp kapanıyor.",
  "changelog.r20260926.improved3":
    "Kartlar taşıdığınızda veya yeniden boyutlandırdığınızda yerine oturmaya devam ediyor, ancak kılavuz çizgileri artık tuvalin üzerine çizilmiyor.",
  "changelog.r20260926.improved4":
    "Devir kartı panodan kaldırıldı. “Siz yokken” penceresi açılışta ve Shift+M ile açılmaya devam ediyor.",
  "changelog.r20260924.new1":
    "İşlem seansının programını gösteren bir Takvim kartı eklendi: her olayın saati, neyi kapsadığı ve günün şu an nerede olduğunu gösteren bir çizgi. Başlık, bugünü mü, bir sonraki seansı mı yoksa öncekini mi gösterdiğini New York'un UTC farkıyla birlikte belirtir.",
  "changelog.r20260924.new2":
    "Panoya bir Haberler kartı eklendi.",
  "changelog.r20260924.new3":
    "Açılış brifingi eklendi. ABD piyasası açılmadan önce her oturumda bir kez, kısa bir pencere siz yokken olanları özetler; Haberler, Bilançolar ve Diğer için birer satır ve her biri için Daha fazla göster bağlantısı içerir. İstediğiniz zaman açmak için Shift+M'ye basın.",
  "changelog.r20260924.new4":
    "Profil düğmesine e-posta adresinizi, Ayarlar'ı ve Çıkış yap'ı içeren bir hesap menüsü eklendi.",
  "changelog.r20260924.improved1":
    "Pozisyonlar kartını genişletmek artık sütunları sıçrayarak eklemek yerine tablonun daha fazlasını akıcı biçimde görünüme kaydırıyor.",
  "changelog.r20260924.improved2":
    "Portföy Değeri kartında grafiğin zaman aralığını seçmek için bir ayar paneli var ve karşılaştırma çizgileri artık grafiğin arkasına çizilmiyor.",
  "changelog.r20260924.improved3":
    "Kartlar artık taşıdığınızda ve yeniden boyutlandırdığınızda birbirlerinin kenarlarına ve boyutlarına hizalanıyor.",
  "changelog.r20260924.improved4":
    "Açılış brifingi gizlilik moduna uyuyor ve dolar tutarlarını gizliyor.",
  "changelog.r20260921.new1":
    "Panonuz artık serbest bir tuval: kartları istediğiniz yere sürükleyin, üst üste gelmelerine izin verin; dokunduğunuz kart öne gelir. Bir yerleşim, büyük bir monitörden dizüstü bilgisayara geçtiğinizde oranlarını korur.",
  "changelog.r20260921.new2":
    "Pozisyonlar kartına beta, maruziyet, erişim, volatilite, momentum ve 52 haftalık sütunlar eklendi. Piyasanın zar zor açıkladığı bir beta soluk çizilir ve üzerine geldiğinizde bunu belirtir.",
  "changelog.r20260921.new3":
    "Portföy Değeri artık diğer tüm kartlarla aynı menüye sahip sıradan bir kart.",
  "changelog.r20260921.improved1":
    "Pozisyonlar artık her grup için ayrı bir başlık yerine tüm liste için sabitlenmiş tek bir sütun başlığına sahip.",
  "changelog.r20260921.improved2":
    "Kâr/zarar değerinizin altındaki satır artık kazançlarınızı veya kayıplarınızı hangi varlıkların taşıdığını ve ne kadarını taşıdığını söylüyor.",
  "changelog.r20260921.improved3":
    "Nakit, bayrağıyla birlikte para birimine göre gösteriliyor ve ETF'lerin Pozisyonlar'da kendi grubu var.",
  "changelog.r20260921.fixed1":
    "Başta ETF'ler olmak üzere varlıkların, panonun okumadığı bir izleyiciye eklendikleri için hiç beta almaması düzeltildi.",
  "changelog.r20260921.fixed2":
    "Bir sunucu çökmesinden sonra canlı pano verilerinin yüklenememesi düzeltildi. Sunucu artık hatalara rağmen çalışmaya devam ediyor ve kendi kendine toparlanıyor.",
  "changelog.r20260921.fixed3":
    "Belleği tükendikçe sunucunun bir iki dakikada bir yeniden başlaması ve canlı verileri sürekli kesmesi düzeltildi.",
  "changelog.r20260916.new1":
    "Karşınızda Falcon: şirketlerin SEC başvurularından oluşturulan ilişki grafikleri, bu ilişkiler boyunca yayılarak ikinci derece sinyallere dönüşen haberlerin takibi ve piyasanın hareketi fiyatlara yansıtıp yansıtmadığına dair bir değerlendirme.",
};
export const de: Table = {
  "changelog.title": "Neuigkeiten",
  "changelog.version": "Version {version}",
  "changelog.section.new": "Neu",
  "changelog.section.improved": "Verbessert",
  "changelog.section.fixed": "Behoben",
  "changelog.r20261004.new1":
    "Neue Seite Konto in den Einstellungen, auf der Sie Ihren vollständigen Namen und Ihre Anrede in Falcon ändern können. Der gewählte Name erscheint in der Begrüßung und im Konto-Button.",
  "changelog.r20261004.new2":
    "Auf der Kontoseite gibt es jetzt Von allen Geräten abmelden. Bevor Sie überall abgemeldet werden, ist ein zweiter Klick nötig.",
  "changelog.r20261004.new3":
    "Die Kalenderkarte hat zwei Pfeile, die einen Handelstag zurück oder vor springen und dabei Wochenenden und Börsenfeiertage überspringen. Die Kopfzeile nennt den angezeigten Tag.",
  "changelog.r20261004.improved1":
    "Wenn einer der Server von Falcon nicht erreichbar ist, sagt die App das jetzt klar, statt nur „HTTP 404“ anzuzeigen.",
  "changelog.r20261004.fixed1":
    "Behoben: Vom Dashboard gelöschte Karten erschienen beim nächsten Öffnen von Falcon wieder.",
  "changelog.r20261003.improved1":
    "Falcon erreicht seine Server jetzt über eigene, feste Adressen. Ein Serverumzug erfordert daher keine neue App-Version mehr.",
  "changelog.r20261003.fixed1":
    "Behoben: Auf einem neu eingerichteten Server stoppte die Nachrichtenbewertung, sodass neue Schlagzeilen keine Relevanzbewertung erhielten.",
  "changelog.r20260926.new1":
    "Neues dunkles Design. Wählen Sie unter Einstellungen → Allgemein → Darstellung zwischen System, Hell und Dunkel. Karten, Suchleiste und Konto-Button erhalten eigene Flächen auf Schwarz und heben sich so weiterhin von der Seite ab.",
  "changelog.r20260926.new2":
    "Neuer Button Modul hinzufügen neben der Suchleiste im Dashboard. Er holt eine entfernte Karte zurück oder fügt eine zweite Kopie einer vorhandenen hinzu und scrollt direkt dorthin.",
  "changelog.r20260926.new3":
    "Fahren Sie mit der Maus über eine Zeile der Kalenderkarte oder wählen Sie sie per Tastatur, um mehr zu sehen: die Uhrzeit in New York und in Ihrer Zeitzone, worum es bei der Veröffentlichung geht, wie wichtig sie ist und woher ihr Datum stammt.",
  "changelog.r20260926.improved1":
    "Der Konto-Button sitzt jetzt links der Suchleiste, sodass ein längerer Name von der Suchleiste weg wächst statt in sie hinein.",
  "changelog.r20260926.improved2":
    "Alle Dropdowns im Dashboard öffnen und schließen jetzt mit einer schlichten Überblendung.",
  "changelog.r20260926.improved3":
    "Karten rasten beim Verschieben und Skalieren weiterhin ein, aber die Hilfslinien werden nicht mehr über die Fläche gezeichnet.",
  "changelog.r20260926.improved4":
    "Die Übergabekarte wurde aus dem Dashboard entfernt. Das Fenster „Während Sie weg waren“ öffnet sich weiterhin beim Start und mit Shift+M.",
  "changelog.r20260924.new1":
    "Neue Kalenderkarte mit dem Ablauf der Handelssitzung: die Uhrzeit jedes Termins, worum es geht, und eine Linie, die zeigt, wo der Tag gerade steht. Die Kopfzeile sagt, ob heute, die nächste oder die letzte Sitzung angezeigt wird, zusammen mit dem UTC-Versatz von New York.",
  "changelog.r20260924.new2":
    "Neue Nachrichtenkarte im Dashboard.",
  "changelog.r20260924.new3":
    "Neues Start-Briefing. Einmal pro Sitzung vor der Eröffnung des US-Marktes fasst ein kurzes Fenster zusammen, was in Ihrer Abwesenheit passiert ist, mit je einer Zeile für Nachrichten, Quartalszahlen und Sonstiges und jeweils einem Link für mehr. Mit Shift+M öffnen Sie es jederzeit.",
  "changelog.r20260924.new4":
    "Der Profil-Button hat ein Kontomenü mit Ihrer E-Mail-Adresse, Einstellungen und Abmelden.",
  "changelog.r20260924.improved1":
    "Wenn Sie die Positionen-Karte verbreitern, gleitet jetzt mehr von der Tabelle fließend ins Bild, statt Spalten sprunghaft hinzuzufügen.",
  "changelog.r20260924.improved2":
    "Die Karte Portfoliowert hat ein Einstellungsfeld für den Zeitraum des Charts, und Vergleichslinien werden nicht mehr hinter dem Chart gezeichnet.",
  "changelog.r20260924.improved3":
    "Karten richten sich beim Verschieben und Skalieren jetzt an den Kanten und Größen der anderen aus.",
  "changelog.r20260924.improved4":
    "Das Start-Briefing beachtet den Privatsphäremodus und blendet Dollarbeträge aus.",
  "changelog.r20260921.new1":
    "Ihr Dashboard ist jetzt eine freie Fläche: Ziehen Sie Karten beliebig, lassen Sie sie überlappen, und die berührte Karte kommt nach vorn. Ein Layout behält seine Proportionen, wenn Sie vom großen Monitor zum Laptop wechseln.",
  "changelog.r20260921.new2":
    "Neue Spalten in der Positionen-Karte: Beta, Exposure, Reichweite, Volatilität, Momentum und 52 Wochen. Ein Beta, das der Markt kaum erklärt, erscheint blass und sagt das beim Darüberfahren.",
  "changelog.r20260921.new3":
    "Portfoliowert ist jetzt eine normale Karte mit demselben Menü wie alle anderen Karten.",
  "changelog.r20260921.improved1":
    "Positionen hat jetzt eine fixierte Spaltenüberschrift für die ganze Liste statt einer pro Gruppe.",
  "changelog.r20260921.improved2":
    "Die Zeile unter Ihrem Gewinn und Verlust nennt jetzt, welche Positionen Ihre Gewinne oder Verluste tragen und wie viel davon.",
  "changelog.r20260921.improved3":
    "Bargeld wird nach Währung mit Flagge angezeigt, und ETFs haben in Positionen eine eigene Gruppe.",
  "changelog.r20260921.fixed1":
    "Behoben: Positionen, besonders ETFs, erhielten nie ein Beta, weil sie einem Tracker hinzugefügt wurden, den das Dashboard nicht las.",
  "changelog.r20260921.fixed2":
    "Behoben: Live-Daten des Dashboards luden nach einem Serverabsturz nicht. Der Server läuft bei Fehlern jetzt weiter und erholt sich selbst.",
  "changelog.r20260921.fixed3":
    "Behoben: Der Server startete alle ein bis zwei Minuten neu, weil der Speicher ausging, und unterbrach so ständig die Live-Daten.",
  "changelog.r20260916.new1":
    "Das ist Falcon: Beziehungsgraphen aus den SEC-Einreichungen von Unternehmen, Nachrichten, die verfolgt werden, während sie sich über diese Beziehungen zu Signalen zweiter Ordnung ausbreiten, und eine Einschätzung, ob der Markt die Bewegung bereits eingepreist hat.",
};
export const fr: Table = {
  "changelog.title": "Nouveautés",
  "changelog.version": "Version {version}",
  "changelog.section.new": "Nouveau",
  "changelog.section.improved": "Amélioré",
  "changelog.section.fixed": "Corrigé",
  "changelog.r20261004.new1":
    "Ajout d'une page Compte dans les Paramètres, où vous pouvez modifier votre nom complet et la façon dont Falcon s'adresse à vous. Le nom choisi est celui qu'utilisent le message d'accueil et le bouton du compte.",
  "changelog.r20261004.new2":
    "Ajout de Se déconnecter de tous les appareils sur la page Compte. Une seconde pression est demandée avant de vous déconnecter partout.",
  "changelog.r20261004.new3":
    "Ajout de deux flèches sur la carte Calendrier pour reculer ou avancer d'une séance, en sautant les week-ends et les jours fériés boursiers. L'en-tête indique le jour affiché.",
  "changelog.r20261004.improved1":
    "Quand l'un des serveurs de Falcon est indisponible, l'application le dit désormais clairement au lieu d'afficher un simple « HTTP 404 ».",
  "changelog.r20261004.fixed1":
    "Correction des cartes supprimées du tableau de bord qui revenaient à la réouverture de Falcon.",
  "changelog.r20261003.improved1":
    "Falcon joint désormais ses serveurs à des adresses permanentes qui lui sont propres : déplacer les serveurs n'oblige plus à installer une nouvelle version de l'application.",
  "changelog.r20261003.fixed1":
    "Correction de la notation des actualités qui s'arrêtait sur un serveur fraîchement installé, laissant les nouveaux titres sans verdict de pertinence.",
  "changelog.r20260926.new1":
    "Ajout d'un thème sombre. Choisissez Système, Clair ou Sombre dans Paramètres → Général → Apparence. Les cartes, la barre de recherche et le bouton du compte ont leurs propres surfaces sur fond noir et restent ainsi distincts de la page.",
  "changelog.r20260926.new2":
    "Ajout d'un bouton Ajouter un module à côté de la barre de recherche du tableau de bord. Il fait revenir une carte retirée, ou ajoute une seconde copie d'une carte existante, puis fait défiler jusqu'à elle.",
  "changelog.r20260926.new3":
    "Survolez une ligne de la carte Calendrier, ou atteignez-la au clavier, pour en voir plus : l'heure à New York et dans votre fuseau horaire, ce que couvre la publication, son importance et l'origine de sa date.",
  "changelog.r20260926.improved1":
    "Le bouton du compte est passé à gauche de la barre de recherche : un nom plus long s'étend désormais en s'éloignant de la barre de recherche au lieu de l'empiéter.",
  "changelog.r20260926.improved2":
    "Tous les menus déroulants du tableau de bord s'ouvrent et se ferment désormais avec un simple fondu.",
  "changelog.r20260926.improved3":
    "Les cartes s'alignent toujours quand vous les déplacez ou les redimensionnez, mais les lignes de repère ne sont plus dessinées sur le canevas.",
  "changelog.r20260926.improved4":
    "La carte de passation a été retirée du tableau de bord. La fenêtre « pendant votre absence » s'ouvre toujours au lancement et avec Shift+M.",
  "changelog.r20260924.new1":
    "Ajout d'une carte Calendrier avec le programme de la séance : l'heure de chaque événement, ce qu'il couvre et une ligne indiquant où en est la journée. L'en-tête précise s'il s'agit d'aujourd'hui, de la prochaine séance ou de la précédente, avec le décalage UTC de New York.",
  "changelog.r20260924.new2":
    "Ajout d'une carte Actualités au tableau de bord.",
  "changelog.r20260924.new3":
    "Ajout d'un briefing de lancement. Une fois par session avant l'ouverture du marché américain, une courte fenêtre résume ce qui s'est passé pendant votre absence, avec une ligne pour Actualités, Résultats et Autres, et un lien pour en voir plus sur chacune. Appuyez sur Shift+M pour l'ouvrir à tout moment.",
  "changelog.r20260924.new4":
    "Ajout d'un menu de compte au bouton de profil, avec votre adresse e-mail, les Paramètres et Se déconnecter.",
  "changelog.r20260924.improved1":
    "Élargir la carte Positions fait désormais glisser davantage du tableau en douceur, au lieu d'ajouter des colonnes par à-coups.",
  "changelog.r20260924.improved2":
    "La carte Valeur du portefeuille dispose d'un panneau de réglages pour choisir la période du graphique, et les lignes de comparaison ne sont plus dessinées derrière le graphique.",
  "changelog.r20260924.improved3":
    "Les cartes s'alignent désormais sur les bords et les tailles des autres quand vous les déplacez et les redimensionnez.",
  "changelog.r20260924.improved4":
    "Le briefing de lancement respecte le mode confidentialité et masque les montants en dollars.",
  "changelog.r20260921.new1":
    "Votre tableau de bord est désormais un canevas libre : faites glisser les cartes où vous voulez, laissez-les se chevaucher, et la carte que vous touchez passe au premier plan. Une disposition garde ses proportions quand vous passez d'un grand écran à un ordinateur portable.",
  "changelog.r20260921.new2":
    "Ajout des colonnes bêta, exposition, portée, volatilité, momentum et 52 semaines à la carte Positions. Un bêta que le marché explique à peine est affiché en pâle et le signale au survol.",
  "changelog.r20260921.new3":
    "Valeur du portefeuille est désormais une carte ordinaire, avec le même menu que toutes les autres.",
  "changelog.r20260921.improved1":
    "Positions a désormais un seul en-tête de colonnes épinglé pour toute la liste, au lieu d'un par groupe.",
  "changelog.r20260921.improved2":
    "La ligne sous votre résultat indique désormais quelles positions portent vos gains ou vos pertes, et dans quelle mesure.",
  "changelog.r20260921.improved3":
    "Les liquidités sont affichées par devise avec leur drapeau, et les ETF ont leur propre groupe dans Positions.",
  "changelog.r20260921.fixed1":
    "Correction des positions, en particulier les ETF, qui n'obtenaient jamais de bêta parce qu'elles étaient ajoutées à un suivi que le tableau de bord ne lisait pas.",
  "changelog.r20260921.fixed2":
    "Correction des données en direct du tableau de bord qui ne se chargeaient plus après une panne du serveur. Le serveur reste désormais actif malgré les erreurs et se rétablit seul.",
  "changelog.r20260921.fixed3":
    "Correction du serveur qui redémarrait toutes les une à deux minutes faute de mémoire, ce qui interrompait sans cesse les données en direct.",
  "changelog.r20260916.new1":
    "Voici Falcon : des graphes de relations construits à partir des dépôts SEC des entreprises, un suivi des actualités à mesure qu'elles se propagent à travers ces relations en signaux de second ordre, et une lecture de ce que le marché a déjà intégré dans les prix.",
};
export const es: Table = {
  "changelog.title": "Novedades",
  "changelog.version": "Versión {version}",
  "changelog.section.new": "Nuevo",
  "changelog.section.improved": "Mejorado",
  "changelog.section.fixed": "Corregido",
  "changelog.r20261004.new1":
    "Nueva página Cuenta en Ajustes, donde puedes cambiar tu nombre completo y cómo te llama Falcon. El nombre que elijas es el que usan el saludo y el botón de la cuenta.",
  "changelog.r20261004.new2":
    "Nueva opción Cerrar sesión en todos los dispositivos en la página Cuenta. Pide una segunda pulsación antes de cerrar tu sesión en todas partes.",
  "changelog.r20261004.new3":
    "La tarjeta Calendario tiene dos flechas que retroceden o avanzan una sesión bursátil, saltando fines de semana y festivos de mercado. El encabezado indica el día que estás viendo.",
  "changelog.r20261004.improved1":
    "Cuando uno de los servidores de Falcon no está disponible, la aplicación ahora lo dice con claridad en lugar de mostrar solo “HTTP 404”.",
  "changelog.r20261004.fixed1":
    "Corregido: las tarjetas que eliminabas del panel volvían la siguiente vez que abrías Falcon.",
  "changelog.r20261003.improved1":
    "Falcon ahora llega a sus servidores en direcciones permanentes propias, así que mover los servidores ya no obliga a instalar una nueva versión de la aplicación.",
  "changelog.r20261003.fixed1":
    "Corregido: la puntuación de noticias se detenía en un servidor recién configurado y los titulares nuevos quedaban sin veredicto de relevancia.",
  "changelog.r20260926.new1":
    "Nuevo tema oscuro. Elige Sistema, Claro u Oscuro en Ajustes → General → Apariencia. Las tarjetas, la barra de búsqueda y el botón de la cuenta tienen superficies propias sobre negro, así que siguen destacando sobre la página.",
  "changelog.r20260926.new2":
    "Nuevo botón Añadir módulo junto a la barra de búsqueda del panel. Recupera una tarjeta que quitaste, o añade una segunda copia de una que ya está, y se desplaza directamente hasta ella.",
  "changelog.r20260926.new3":
    "Pasa el puntero sobre una fila de la tarjeta Calendario, o llega a ella con el teclado, para ver más: la hora en Nueva York y en tu zona horaria, qué cubre la publicación, cuánto importa y de dónde sale su fecha.",
  "changelog.r20260926.improved1":
    "El botón de la cuenta pasa a la izquierda de la barra de búsqueda, de modo que un nombre largo crece alejándose de la barra en lugar de invadirla.",
  "changelog.r20260926.improved2":
    "Todos los menús desplegables del panel se abren y cierran ahora con un simple fundido.",
  "changelog.r20260926.improved3":
    "Las tarjetas siguen encajando en su sitio al moverlas o cambiarles el tamaño, pero las guías ya no se dibujan sobre el lienzo.",
  "changelog.r20260926.improved4":
    "Se quitó la tarjeta de relevo del panel. La ventana “mientras no estabas” sigue abriéndose al iniciar y con Shift+M.",
  "changelog.r20260924.new1":
    "Nueva tarjeta Calendario con el horario de la sesión bursátil: la hora de cada evento, qué cubre y una línea que muestra en qué punto está el día. El encabezado indica si muestra hoy, la próxima sesión o la anterior, junto con la diferencia UTC de Nueva York.",
  "changelog.r20260924.new2":
    "Nueva tarjeta Noticias en el panel.",
  "changelog.r20260924.new3":
    "Nuevo resumen de inicio. Una vez por sesión antes de la apertura del mercado estadounidense, una breve ventana resume lo que pasó mientras no estabas, con una línea para Noticias, Resultados y Otros y un enlace para ver más en cada una. Pulsa Shift+M para abrirlo cuando quieras.",
  "changelog.r20260924.new4":
    "El botón de perfil tiene un menú de cuenta con tu correo electrónico, Ajustes y Cerrar sesión.",
  "changelog.r20260924.improved1":
    "Al ensanchar la tarjeta Posiciones, ahora se desliza a la vista más parte de la tabla con suavidad, en lugar de añadir columnas a saltos.",
  "changelog.r20260924.improved2":
    "La tarjeta Valor de la cartera tiene un panel de ajustes para elegir el periodo del gráfico, y las líneas de comparación ya no se dibujan detrás del gráfico.",
  "changelog.r20260924.improved3":
    "Las tarjetas se alinean ahora con los bordes y tamaños de las demás al moverlas y cambiarles el tamaño.",
  "changelog.r20260924.improved4":
    "El resumen de inicio respeta el modo privacidad y oculta los importes en dólares.",
  "changelog.r20260921.new1":
    "Tu panel es ahora un lienzo libre: arrastra las tarjetas a donde quieras, deja que se superpongan, y la que tocas pasa al frente. Un diseño mantiene sus proporciones cuando pasas de un monitor grande a un portátil.",
  "changelog.r20260921.new2":
    "Nuevas columnas de beta, exposición, alcance, volatilidad, momentum y 52 semanas en la tarjeta Posiciones. Una beta que el mercado apenas explica aparece tenue y lo indica al pasar el puntero.",
  "changelog.r20260921.new3":
    "Valor de la cartera es ahora una tarjeta normal con el mismo menú que todas las demás.",
  "changelog.r20260921.improved1":
    "Posiciones tiene ahora un único encabezado de columnas fijo para toda la lista, en lugar de uno por grupo.",
  "changelog.r20260921.improved2":
    "La línea bajo tus pérdidas y ganancias indica ahora qué posiciones explican tus ganancias o pérdidas, y en qué medida.",
  "changelog.r20260921.improved3":
    "El efectivo se muestra por divisa con su bandera, y los ETF tienen su propio grupo en Posiciones.",
  "changelog.r20260921.fixed1":
    "Corregido: las posiciones, sobre todo los ETF, nunca recibían una beta porque se añadían a un rastreador que el panel no leía.",
  "changelog.r20260921.fixed2":
    "Corregido: los datos en directo del panel no cargaban tras una caída del servidor. Ahora el servidor sigue funcionando ante errores y se recupera solo.",
  "changelog.r20260921.fixed3":
    "Corregido: el servidor se reiniciaba cada uno o dos minutos al quedarse sin memoria, lo que interrumpía continuamente los datos en directo.",
  "changelog.r20260916.new1":
    "Presentamos Falcon: grafos de relaciones construidos a partir de las presentaciones de las empresas ante la SEC, seguimiento de noticias mientras se propagan por esas relaciones en señales de segundo orden, y una lectura de si el mercado ya ha descontado el movimiento.",
};
export const it: Table = {
  "changelog.title": "Novità",
  "changelog.version": "Versione {version}",
  "changelog.section.new": "Nuovo",
  "changelog.section.improved": "Migliorato",
  "changelog.section.fixed": "Corretto",
  "changelog.r20261004.new1":
    "Aggiunta una pagina Account nelle Impostazioni, dove puoi cambiare il tuo nome completo e come ti chiama Falcon. Il nome scelto è quello usato dal saluto e dal pulsante dell'account.",
  "changelog.r20261004.new2":
    "Aggiunto Esci da tutti i dispositivi alla pagina Account. Chiede una seconda pressione prima di disconnetterti ovunque.",
  "changelog.r20261004.new3":
    "Aggiunte alla scheda Calendario due frecce che vanno indietro o avanti di una seduta, saltando i fine settimana e le festività di borsa. L'intestazione indica il giorno che stai guardando.",
  "changelog.r20261004.improved1":
    "Quando uno dei server di Falcon non è disponibile, l'app ora lo dice chiaramente invece di mostrare un semplice “HTTP 404”.",
  "changelog.r20261004.fixed1":
    "Corretto il problema per cui le schede eliminate dalla dashboard ricomparivano alla successiva apertura di Falcon.",
  "changelog.r20261003.improved1":
    "Falcon ora raggiunge i suoi server a indirizzi permanenti propri, quindi spostare i server non richiede più di installare una nuova versione dell'app.",
  "changelog.r20261003.fixed1":
    "Corretto il blocco della valutazione delle notizie su un server appena configurato, che lasciava i nuovi titoli senza un giudizio di rilevanza.",
  "changelog.r20260926.new1":
    "Aggiunto un tema scuro. Scegli Sistema, Chiaro o Scuro in Impostazioni → Generali → Aspetto. Le schede, la barra di ricerca e il pulsante dell'account hanno superfici proprie sul nero, così restano distinti dalla pagina.",
  "changelog.r20260926.new2":
    "Aggiunto un pulsante Aggiungi modulo accanto alla barra di ricerca della dashboard. Riporta una scheda che hai rimosso, o aggiunge una seconda copia di una già presente, e scorre direttamente fino a essa.",
  "changelog.r20260926.new3":
    "Passa il puntatore su una riga della scheda Calendario, o raggiungila con la tastiera, per vedere di più: l'orario a New York e nel tuo fuso orario, cosa riguarda la pubblicazione, quanto conta e da dove viene la sua data.",
  "changelog.r20260926.improved1":
    "Il pulsante dell'account è stato spostato a sinistra della barra di ricerca, così un nome più lungo si allunga allontanandosi dalla barra invece di invaderla.",
  "changelog.r20260926.improved2":
    "Tutti i menu a discesa della dashboard ora si aprono e si chiudono con una semplice dissolvenza.",
  "changelog.r20260926.improved3":
    "Le schede si agganciano ancora quando le sposti o le ridimensioni, ma le linee guida non vengono più disegnate sull'area di lavoro.",
  "changelog.r20260926.improved4":
    "Rimossa la scheda di passaggio dalla dashboard. La finestra “mentre eri via” si apre ancora all'avvio e con Shift+M.",
  "changelog.r20260924.new1":
    "Aggiunta una scheda Calendario con il programma della seduta: l'orario di ogni evento, cosa riguarda e una linea che mostra a che punto è la giornata. L'intestazione indica se mostra oggi, la prossima seduta o l'ultima, insieme allo scostamento UTC di New York.",
  "changelog.r20260924.new2":
    "Aggiunta una scheda Notizie alla dashboard.",
  "changelog.r20260924.new3":
    "Aggiunto un briefing di avvio. Una volta per sessione prima dell'apertura del mercato statunitense, una breve finestra riassume cosa è successo mentre eri via, con una riga ciascuna per Notizie, Risultati e Altro e un collegamento per approfondire ognuna. Premi Shift+M per aprirlo in qualsiasi momento.",
  "changelog.r20260924.new4":
    "Aggiunto al pulsante del profilo un menu dell'account con il tuo indirizzo email, Impostazioni ed Esci.",
  "changelog.r20260924.improved1":
    "Allargando la scheda Posizioni ora una parte maggiore della tabella scorre in vista in modo fluido, invece di aggiungere colonne a scatti.",
  "changelog.r20260924.improved2":
    "La scheda Valore del portafoglio ha un pannello di impostazioni per scegliere l'intervallo del grafico, e le linee di confronto non vengono più disegnate dietro il grafico.",
  "changelog.r20260924.improved3":
    "Le schede ora si allineano ai bordi e alle dimensioni delle altre mentre le sposti e le ridimensioni.",
  "changelog.r20260924.improved4":
    "Il briefing di avvio rispetta la modalità privacy e nasconde gli importi in dollari.",
  "changelog.r20260921.new1":
    "La tua dashboard è ora un'area libera: trascina le schede dove vuoi, lasciale sovrapporre, e la scheda che tocchi passa in primo piano. Un layout mantiene le proporzioni quando passi da un monitor grande a un portatile.",
  "changelog.r20260921.new2":
    "Aggiunte alla scheda Posizioni le colonne beta, esposizione, portata, volatilità, momentum e 52 settimane. Un beta che il mercato spiega appena è disegnato in tenue e lo segnala al passaggio del puntatore.",
  "changelog.r20260921.new3":
    "Valore del portafoglio è ora una scheda normale con lo stesso menu di tutte le altre.",
  "changelog.r20260921.improved1":
    "Posizioni ora ha un'unica intestazione di colonna fissata per l'intero elenco, invece di una per gruppo.",
  "changelog.r20260921.improved2":
    "La riga sotto il tuo profitto e perdita ora indica quali posizioni determinano i tuoi guadagni o le tue perdite, e in che misura.",
  "changelog.r20260921.improved3":
    "La liquidità è mostrata per valuta con la sua bandiera, e gli ETF hanno un gruppo proprio in Posizioni.",
  "changelog.r20260921.fixed1":
    "Corretto il problema per cui le posizioni, in particolare gli ETF, non ricevevano mai un beta perché venivano aggiunte a un tracker che la dashboard non leggeva.",
  "changelog.r20260921.fixed2":
    "Corretto il mancato caricamento dei dati in diretta della dashboard dopo un arresto del server. Il server ora resta attivo anche in caso di errori e si ripristina da solo.",
  "changelog.r20260921.fixed3":
    "Corretto il riavvio del server ogni uno o due minuti per esaurimento della memoria, che interrompeva continuamente i dati in diretta.",
  "changelog.r20260916.new1":
    "Ecco Falcon: grafi delle relazioni costruiti dai documenti SEC delle società, notizie seguite mentre si propagano attraverso quelle relazioni in segnali di secondo ordine, e una lettura di quanto il mercato abbia già prezzato il movimento.",
};
export const ptBR: Table = {
  "changelog.title": "Novidades",
  "changelog.version": "Versão {version}",
  "changelog.section.new": "Novo",
  "changelog.section.improved": "Melhorado",
  "changelog.section.fixed": "Corrigido",
  "changelog.r20261004.new1":
    "Nova página Conta nas Configurações, onde você pode mudar seu nome completo e como o Falcon chama você. O nome escolhido é o usado na saudação e no botão da conta.",
  "changelog.r20261004.new2":
    "Nova opção Sair de todos os dispositivos na página Conta. Ela pede um segundo toque antes de encerrar sua sessão em todos os lugares.",
  "changelog.r20261004.new3":
    "O cartão Calendário ganhou duas setas que voltam ou avançam um pregão, pulando fins de semana e feriados do mercado. O cabeçalho mostra o dia que você está vendo.",
  "changelog.r20261004.improved1":
    "Quando um dos servidores do Falcon está indisponível, o app agora diz isso com clareza em vez de mostrar só “HTTP 404”.",
  "changelog.r20261004.fixed1":
    "Corrigido: cartões excluídos do painel voltavam na próxima vez que você abria o Falcon.",
  "changelog.r20261003.improved1":
    "O Falcon agora acessa seus servidores em endereços permanentes próprios, então mudar os servidores de lugar não exige mais instalar uma nova versão do app.",
  "changelog.r20261003.fixed1":
    "Corrigido: a pontuação de notícias parava em um servidor recém-configurado, deixando novas manchetes sem avaliação de relevância.",
  "changelog.r20260926.new1":
    "Novo tema escuro. Escolha Sistema, Claro ou Escuro em Configurações → Geral → Aparência. Cartões, barra de busca e botão da conta ganham superfícies próprias sobre o preto, para continuarem se destacando da página.",
  "changelog.r20260926.new2":
    "Novo botão Adicionar módulo ao lado da barra de busca no painel. Ele traz de volta um cartão removido, ou adiciona uma segunda cópia de um que já está lá, e rola direto até ele.",
  "changelog.r20260926.new3":
    "Passe o ponteiro sobre uma linha do cartão Calendário, ou chegue a ela pelo teclado, para ver mais: o horário em Nova York e no seu fuso, o que a divulgação cobre, quanto ela importa e de onde vem a data.",
  "changelog.r20260926.improved1":
    "O botão da conta foi para a esquerda da barra de busca, então um nome mais longo cresce para longe da barra em vez de invadi-la.",
  "changelog.r20260926.improved2":
    "Todos os menus suspensos do painel agora abrem e fecham com um esmaecimento simples.",
  "changelog.r20260926.improved3":
    "Os cartões continuam se encaixando ao mover ou redimensionar, mas as linhas-guia não são mais desenhadas sobre a área de trabalho.",
  "changelog.r20260926.improved4":
    "O cartão de passagem foi removido do painel. A janela “enquanto você esteve fora” continua abrindo ao iniciar e com Shift+M.",
  "changelog.r20260924.new1":
    "Novo cartão Calendário com a agenda do pregão: o horário de cada evento, o que ele cobre e uma linha mostrando em que ponto o dia está. O cabeçalho diz se mostra hoje, o próximo pregão ou o anterior, junto com a diferença UTC de Nova York.",
  "changelog.r20260924.new2":
    "Novo cartão Notícias no painel.",
  "changelog.r20260924.new3":
    "Novo resumo de abertura. Uma vez por sessão antes da abertura do mercado americano, uma janela curta resume o que aconteceu enquanto você esteve fora, com uma linha para Notícias, Resultados e Outros e um link para ver mais em cada uma. Pressione Shift+M para abri-lo a qualquer momento.",
  "changelog.r20260924.new4":
    "O botão de perfil ganhou um menu de conta com seu e-mail, Configurações e Sair.",
  "changelog.r20260924.improved1":
    "Ao alargar o cartão Posições, mais da tabela agora desliza suavemente para a vista, em vez de colunas aparecerem aos saltos.",
  "changelog.r20260924.improved2":
    "O cartão Valor da carteira tem um painel de configurações para escolher o período do gráfico, e as linhas de comparação não são mais desenhadas atrás do gráfico.",
  "changelog.r20260924.improved3":
    "Os cartões agora se alinham às bordas e aos tamanhos uns dos outros ao mover e redimensionar.",
  "changelog.r20260924.improved4":
    "O resumo de abertura respeita o modo de privacidade e oculta valores em dólar.",
  "changelog.r20260921.new1":
    "Seu painel agora é uma área livre: arraste os cartões para qualquer lugar, deixe que se sobreponham, e o cartão que você toca vem para a frente. Um layout mantém as proporções quando você passa de um monitor grande para um notebook.",
  "changelog.r20260921.new2":
    "Novas colunas de beta, exposição, alcance, volatilidade, momentum e 52 semanas no cartão Posições. Um beta que o mercado mal explica aparece esmaecido e avisa isso ao passar o ponteiro.",
  "changelog.r20260921.new3":
    "Valor da carteira agora é um cartão comum, com o mesmo menu de todos os outros.",
  "changelog.r20260921.improved1":
    "Posições agora tem um único cabeçalho de colunas fixo para a lista inteira, em vez de um por grupo.",
  "changelog.r20260921.improved2":
    "A linha abaixo do seu resultado agora diz quais posições explicam seus ganhos ou perdas, e em que medida.",
  "changelog.r20260921.improved3":
    "O caixa aparece por moeda com a bandeira, e os ETFs têm um grupo próprio em Posições.",
  "changelog.r20260921.fixed1":
    "Corrigido: posições, especialmente ETFs, nunca recebiam beta porque eram adicionadas a um rastreador que o painel não lia.",
  "changelog.r20260921.fixed2":
    "Corrigido: os dados ao vivo do painel não carregavam depois de uma queda do servidor. Agora o servidor continua no ar diante de erros e se recupera sozinho.",
  "changelog.r20260921.fixed3":
    "Corrigido: o servidor reiniciava a cada um ou dois minutos por falta de memória, interrompendo os dados ao vivo o tempo todo.",
  "changelog.r20260916.new1":
    "Apresentamos o Falcon: grafos de relações construídos a partir dos documentos das empresas na SEC, notícias acompanhadas enquanto se espalham por essas relações em sinais de segunda ordem, e uma leitura sobre se o mercado já precificou o movimento.",
};
export const ja: Table = {
  "changelog.title": "最新情報",
  "changelog.version": "バージョン{version}",
  "changelog.section.new": "新機能",
  "changelog.section.improved": "改善",
  "changelog.section.fixed": "修正",
  "changelog.r20261004.new1":
    "設定にアカウントページを追加しました。フルネームと、Falconでの呼び名を変更できます。選んだ名前は挨拶とアカウントボタンに使われます。",
  "changelog.r20261004.new2":
    "アカウントページに「すべてのデバイスからログアウト」を追加しました。すべての場所からログアウトする前に、もう一度押して確認します。",
  "changelog.r20261004.new3":
    "カレンダーカードに、週末と市場休日を飛ばして1営業日ずつ前後に移動する2つの矢印を追加しました。見出しには表示中の日付が出ます。",
  "changelog.r20261004.improved1":
    "Falconのサーバーのいずれかが利用できないとき、「HTTP 404」とだけ表示するのではなく、そのことをはっきり伝えるようになりました。",
  "changelog.r20261004.fixed1":
    "ダッシュボードから削除したカードが、次にFalconを開いたときに戻ってくる問題を修正しました。",
  "changelog.r20261003.improved1":
    "Falconは独自の固定アドレスでサーバーに接続するようになりました。サーバーを移しても、アプリの新しいバージョンをインストールする必要はありません。",
  "changelog.r20261003.fixed1":
    "新しく構築したサーバーでニュースのスコアリングが止まり、新しい見出しに関連性の判定が付かなかった問題を修正しました。",
  "changelog.r20260926.new1":
    "ダークテーマを追加しました。設定 → 一般 → 外観で「システム」「ライト」「ダーク」から選べます。カード、検索バー、アカウントボタンは黒地の上に独自の面を持つため、ページから区別して見えます。",
  "changelog.r20260926.new2":
    "ダッシュボードの検索バーの横に「モジュールを追加」ボタンを追加しました。削除したカードを戻したり、既存のカードの2つ目を追加したりでき、そのカードまで自動でスクロールします。",
  "changelog.r20260926.new3":
    "カレンダーカードの行にポインタを合わせるか、キーボードで移動すると、詳細が表示されます。ニューヨーク時間とお使いのタイムゾーンでの時刻、発表の内容、重要度、日付の出典です。",
  "changelog.r20260926.improved1":
    "アカウントボタンを検索バーの左側に移しました。長い名前でも検索バーに食い込まず、反対側に伸びます。",
  "changelog.r20260926.improved2":
    "ダッシュボードのすべてのドロップダウンが、シンプルなフェードで開閉するようになりました。",
  "changelog.r20260926.improved3":
    "カードは移動やサイズ変更の際に引き続き吸着しますが、ガイド線はキャンバス上に描かれなくなりました。",
  "changelog.r20260926.improved4":
    "ダッシュボードから引き継ぎカードを削除しました。「不在の間に」ポップアップは、起動時とShift+Mで引き続き開きます。",
  "changelog.r20260924.new1":
    "取引セッションの予定を表示するカレンダーカードを追加しました。各イベントの時刻と内容に加え、1日の現在位置を示す線が表示されます。見出しには、今日、次のセッション、前回のセッションのどれを表示しているかが、ニューヨークのUTCオフセットとともに示されます。",
  "changelog.r20260924.new2":
    "ダッシュボードにニュースカードを追加しました。",
  "changelog.r20260924.new3":
    "起動時のブリーフィングを追加しました。米国市場が開く前、セッションごとに1回、不在の間の出来事を短いポップアップでまとめます。ニュース、決算、その他をそれぞれ1行で示し、各項目から詳細を開けます。Shift+Mでいつでも開けます。",
  "changelog.r20260924.new4":
    "プロフィールボタンに、メールアドレス、設定、ログアウトを含むアカウントメニューを追加しました。",
  "changelog.r20260924.improved1":
    "保有銘柄カードを広げると、列が段階的に増えるのではなく、テーブルがなめらかに表示範囲に入るようになりました。",
  "changelog.r20260924.improved2":
    "ポートフォリオ評価額カードに、チャートの期間を選ぶ設定パネルを追加しました。比較線はチャートの背後に描かれなくなりました。",
  "changelog.r20260924.improved3":
    "カードを移動やサイズ変更すると、ほかのカードの端やサイズに揃うようになりました。",
  "changelog.r20260924.improved4":
    "起動時のブリーフィングがプライバシーモードに従い、金額を隠すようになりました。",
  "changelog.r20260921.new1":
    "ダッシュボードが自由なキャンバスになりました。カードを好きな場所にドラッグして重ねることができ、触れたカードが前面に来ます。大きなモニターからノートパソコンに移っても、レイアウトの比率は保たれます。",
  "changelog.r20260921.new2":
    "保有銘柄カードに、ベータ、エクスポージャー、波及範囲、ボラティリティ、モメンタム、52週の列を追加しました。市場でほとんど説明できないベータは薄く表示され、ポインタを合わせるとその旨が表示されます。",
  "changelog.r20260921.new3":
    "ポートフォリオ評価額が、ほかのカードと同じメニューを持つ通常のカードになりました。",
  "changelog.r20260921.improved1":
    "保有銘柄の列見出しが、グループごとではなくリスト全体で1つの固定見出しになりました。",
  "changelog.r20260921.improved2":
    "損益の下の行に、どの保有銘柄が利益や損失をもたらしているか、その割合が表示されるようになりました。",
  "changelog.r20260921.improved3":
    "現金は国旗付きの通貨別に表示され、ETFは保有銘柄内で独自のグループになりました。",
  "changelog.r20260921.fixed1":
    "保有銘柄、特にETFが、ダッシュボードの読み取らないトラッカーに追加されていたためにベータが付かなかった問題を修正しました。",
  "changelog.r20260921.fixed2":
    "サーバーのクラッシュ後にダッシュボードのライブデータが読み込めなくなる問題を修正しました。サーバーはエラーが起きても稼働を続け、自動で回復します。",
  "changelog.r20260921.fixed3":
    "メモリ不足でサーバーが1、2分ごとに再起動し、ライブデータが繰り返し途切れていた問題を修正しました。",
  "changelog.r20260916.new1":
    "Falconの登場です。企業のSEC提出書類から作る関係グラフ、その関係を伝って二次シグナルへと広がっていくニュースの追跡、そして市場がその動きをすでに織り込んでいるかどうかの見立てを提供します。",
};
export const zhCN: Table = {
  "changelog.title": "新功能",
  "changelog.version": "版本 {version}",
  "changelog.section.new": "新增",
  "changelog.section.improved": "改进",
  "changelog.section.fixed": "修复",
  "changelog.r20261004.new1":
    "在设置中新增“账户”页面，可在此更改您的全名以及 Falcon 对您的称呼。您选择的名字会用于问候语和账户按钮。",
  "changelog.r20261004.new2":
    "在“账户”页面新增“从所有设备退出”。在让您从所有地方退出之前，需要再按一次确认。",
  "changelog.r20261004.new3":
    "日历卡片新增两个箭头，可向前或向后移动一个交易日，并跳过周末和市场假日。标题会显示您正在查看的日期。",
  "changelog.r20261004.improved1":
    "当 Falcon 的某台服务器不可用时，应用现在会直接说明，而不是只显示“HTTP 404”。",
  "changelog.r20261004.fixed1":
    "修复了从仪表盘删除的卡片在下次打开 Falcon 时重新出现的问题。",
  "changelog.r20261003.improved1":
    "Falcon 现在通过自己的固定地址连接服务器，因此迁移服务器不再需要安装新版本的应用。",
  "changelog.r20261003.fixed1":
    "修复了在新配置的服务器上新闻评分停止、导致新标题没有相关性判定的问题。",
  "changelog.r20260926.new1":
    "新增深色主题。可在 设置 → 通用 → 外观 中选择“系统”“浅色”或“深色”。卡片、搜索栏和账户按钮在黑色背景上有各自的底面，因此仍能与页面区分开来。",
  "changelog.r20260926.new2":
    "在仪表盘搜索栏旁新增“添加模块”按钮。它可以找回您移除的卡片，或为已有卡片再添加一份副本，并直接滚动到该卡片。",
  "changelog.r20260926.new3":
    "将指针悬停在日历卡片的某一行上，或用键盘移动到该行，即可查看更多信息：纽约时间和您所在时区的时间、发布内容涵盖什么、重要程度以及日期来源。",
  "changelog.r20260926.improved1":
    "账户按钮移到了搜索栏左侧，较长的名字会朝远离搜索栏的方向延伸，而不会挤占搜索栏。",
  "changelog.r20260926.improved2":
    "仪表盘的所有下拉菜单现在都以简洁的淡入淡出方式打开和关闭。",
  "changelog.r20260926.improved3":
    "移动或调整卡片大小时仍会自动对齐，但不再在画布上绘制参考线。",
  "changelog.r20260926.improved4":
    "从仪表盘移除了交接卡片。“您离开期间”弹窗仍会在启动时以及按 Shift+M 时打开。",
  "changelog.r20260924.new1":
    "新增日历卡片，展示交易时段的日程：每个事件的时间、涵盖内容，以及一条显示当日进度的线。标题会说明显示的是今天、下一个交易时段还是上一个，并附上纽约的 UTC 时差。",
  "changelog.r20260924.new2":
    "仪表盘新增新闻卡片。",
  "changelog.r20260924.new3":
    "新增启动简报。每次会话在美国市场开盘前显示一次，用简短的弹窗总结您离开期间发生的事情，新闻、财报和其他各一行，每项都可查看更多。按 Shift+M 可随时打开。",
  "changelog.r20260924.new4":
    "头像按钮新增账户菜单，包含您的邮箱地址、设置和退出登录。",
  "changelog.r20260924.improved1":
    "加宽持仓卡片时，表格的更多部分会平滑地滑入视图，而不是一列一列地跳出来。",
  "changelog.r20260924.improved2":
    "投资组合价值卡片新增设置面板，可选择图表的时间范围，比较线也不再绘制在图表后面。",
  "changelog.r20260924.improved3":
    "移动和调整卡片大小时，卡片现在会对齐其他卡片的边缘和尺寸。",
  "changelog.r20260924.improved4":
    "启动简报会遵循隐私模式并隐藏美元金额。",
  "changelog.r20260921.new1":
    "您的仪表盘现在是一块自由画布：可将卡片拖到任意位置并允许重叠，您触碰的卡片会显示在最前面。从大显示器切换到笔记本电脑时，布局会保持原有比例。",
  "changelog.r20260921.new2":
    "持仓卡片新增贝塔、敞口、波及范围、波动率、动量和 52 周列。市场几乎无法解释的贝塔会以浅色显示，悬停时会加以说明。",
  "changelog.r20260921.new3":
    "投资组合价值现在是一张普通卡片，菜单与其他卡片相同。",
  "changelog.r20260921.improved1":
    "持仓现在整个列表只有一个固定的列标题，而不是每组一个。",
  "changelog.r20260921.improved2":
    "盈亏下方的说明现在会指出哪些持仓带来了您的收益或亏损，以及各自占多少。",
  "changelog.r20260921.improved3":
    "现金按币种显示并附国旗，ETF 在持仓中有了单独的分组。",
  "changelog.r20260921.fixed1":
    "修复了持仓（尤其是 ETF）因被添加到仪表盘不读取的跟踪器中而始终没有贝塔值的问题。",
  "changelog.r20260921.fixed2":
    "修复了服务器崩溃后仪表盘实时数据无法加载的问题。服务器现在遇到错误也会保持运行，并能自行恢复。",
  "changelog.r20260921.fixed3":
    "修复了服务器因内存耗尽每一两分钟重启一次、不断中断实时数据的问题。",
  "changelog.r20260916.new1":
    "Falcon 正式推出：基于公司 SEC 文件构建的关系图谱，跟踪新闻沿这些关系扩散并形成二阶信号，以及对市场是否已将这一变动计入价格的判断。",
};
export const ko: Table = {
  "changelog.title": "새로운 기능",
  "changelog.version": "버전 {version}",
  "changelog.section.new": "새 기능",
  "changelog.section.improved": "개선",
  "changelog.section.fixed": "수정",
  "changelog.r20261004.new1":
    "설정에 계정 페이지를 추가했습니다. 전체 이름과 Falcon이 부르는 호칭을 바꿀 수 있습니다. 선택한 이름은 인사말과 계정 버튼에 사용됩니다.",
  "changelog.r20261004.new2":
    "계정 페이지에 모든 기기에서 로그아웃을 추가했습니다. 모든 곳에서 로그아웃하기 전에 한 번 더 눌러 확인합니다.",
  "changelog.r20261004.new3":
    "캘린더 카드에 주말과 휴장일을 건너뛰며 거래일 하루씩 앞뒤로 이동하는 화살표 두 개를 추가했습니다. 머리글에 보고 있는 날짜가 표시됩니다.",
  "changelog.r20261004.improved1":
    "Falcon 서버 중 하나를 사용할 수 없으면, 이제 “HTTP 404”만 보여 주는 대신 그 사실을 분명하게 알려 줍니다.",
  "changelog.r20261004.fixed1":
    "대시보드에서 삭제한 카드가 다음에 Falcon을 열 때 다시 나타나던 문제를 수정했습니다.",
  "changelog.r20261003.improved1":
    "Falcon이 이제 자체 고정 주소로 서버에 연결하므로, 서버를 옮겨도 앱의 새 버전을 설치할 필요가 없습니다.",
  "changelog.r20261003.fixed1":
    "새로 구성한 서버에서 뉴스 점수 매기기가 멈춰 새 헤드라인에 관련성 판정이 붙지 않던 문제를 수정했습니다.",
  "changelog.r20260926.new1":
    "다크 테마를 추가했습니다. 설정 → 일반 → 화면에서 시스템, 라이트, 다크 중에서 고르세요. 카드, 검색창, 계정 버튼은 검은 바탕 위에서 고유한 면을 가져 페이지와 구분됩니다.",
  "changelog.r20260926.new2":
    "대시보드 검색창 옆에 모듈 추가 버튼을 추가했습니다. 제거한 카드를 다시 가져오거나 이미 있는 카드의 사본을 하나 더 추가하고, 그 카드로 바로 스크롤합니다.",
  "changelog.r20260926.new3":
    "캘린더 카드의 행에 포인터를 올리거나 키보드로 이동하면 더 많은 정보를 볼 수 있습니다. 뉴욕 시간과 내 시간대의 시각, 발표 내용, 중요도, 날짜의 출처가 표시됩니다.",
  "changelog.r20260926.improved1":
    "계정 버튼을 검색창 왼쪽으로 옮겼습니다. 이름이 길어도 검색창을 침범하지 않고 반대쪽으로 늘어납니다.",
  "changelog.r20260926.improved2":
    "대시보드의 모든 드롭다운이 이제 간결한 페이드로 열리고 닫힙니다.",
  "changelog.r20260926.improved3":
    "카드를 옮기거나 크기를 바꿀 때 여전히 제자리에 맞춰지지만, 안내선은 더 이상 캔버스 위에 그려지지 않습니다.",
  "changelog.r20260926.improved4":
    "대시보드에서 인수인계 카드를 제거했습니다. “자리를 비운 동안” 팝업은 실행 시와 Shift+M으로 계속 열립니다.",
  "changelog.r20260924.new1":
    "거래 세션 일정을 보여 주는 캘린더 카드를 추가했습니다. 각 이벤트의 시간과 내용, 그리고 하루가 지금 어디쯤인지 보여 주는 선이 표시됩니다. 머리글에는 오늘, 다음 세션, 지난 세션 중 무엇을 보여 주는지가 뉴욕의 UTC 오프셋과 함께 표시됩니다.",
  "changelog.r20260924.new2":
    "대시보드에 뉴스 카드를 추가했습니다.",
  "changelog.r20260924.new3":
    "실행 브리핑을 추가했습니다. 미국 시장 개장 전 세션마다 한 번, 짧은 팝업이 자리를 비운 동안의 일을 요약합니다. 뉴스, 실적, 기타가 각각 한 줄로 표시되며 항목마다 더 보기를 열 수 있습니다. 언제든 Shift+M을 눌러 열 수 있습니다.",
  "changelog.r20260924.new4":
    "프로필 버튼에 이메일 주소, 설정, 로그아웃이 있는 계정 메뉴를 추가했습니다.",
  "changelog.r20260924.improved1":
    "보유 종목 카드를 넓히면 이제 열이 한꺼번에 추가되지 않고, 표의 더 많은 부분이 부드럽게 화면에 들어옵니다.",
  "changelog.r20260924.improved2":
    "포트폴리오 가치 카드에 차트 기간을 고르는 설정 패널이 생겼고, 비교선이 더 이상 차트 뒤에 그려지지 않습니다.",
  "changelog.r20260924.improved3":
    "카드를 옮기거나 크기를 바꿀 때 이제 다른 카드의 가장자리와 크기에 맞춰집니다.",
  "changelog.r20260924.improved4":
    "실행 브리핑이 개인 정보 보호 모드를 따르며 금액을 숨깁니다.",
  "changelog.r20260921.new1":
    "대시보드가 이제 자유로운 캔버스가 되었습니다. 카드를 원하는 곳으로 끌고 겹쳐 둘 수 있으며, 건드린 카드가 맨 앞으로 옵니다. 큰 모니터에서 노트북으로 옮겨도 레이아웃 비율이 유지됩니다.",
  "changelog.r20260921.new2":
    "보유 종목 카드에 베타, 익스포저, 파급 범위, 변동성, 모멘텀, 52주 열을 추가했습니다. 시장으로 거의 설명되지 않는 베타는 흐리게 표시되며, 포인터를 올리면 그 사실을 알려 줍니다.",
  "changelog.r20260921.new3":
    "포트폴리오 가치가 이제 다른 모든 카드와 같은 메뉴를 가진 일반 카드가 되었습니다.",
  "changelog.r20260921.improved1":
    "보유 종목에 그룹마다 따로 있던 머리글 대신 목록 전체에 고정된 열 머리글 하나가 생겼습니다.",
  "changelog.r20260921.improved2":
    "손익 아래 줄에 이제 어떤 보유 종목이 이익이나 손실을 만들었는지와 그 비중이 표시됩니다.",
  "changelog.r20260921.improved3":
    "현금이 국기와 함께 통화별로 표시되고, ETF는 보유 종목에서 별도 그룹으로 묶입니다.",
  "changelog.r20260921.fixed1":
    "보유 종목, 특히 ETF가 대시보드가 읽지 않는 트래커에 추가되어 베타를 받지 못하던 문제를 수정했습니다.",
  "changelog.r20260921.fixed2":
    "서버가 다운된 뒤 대시보드 실시간 데이터가 불러와지지 않던 문제를 수정했습니다. 이제 서버는 오류가 나도 계속 실행되며 스스로 복구합니다.",
  "changelog.r20260921.fixed3":
    "메모리가 부족해 서버가 1~2분마다 다시 시작되면서 실시간 데이터가 계속 끊기던 문제를 수정했습니다.",
  "changelog.r20260916.new1":
    "Falcon을 소개합니다. 기업의 SEC 공시로 만든 관계 그래프, 그 관계를 따라 2차 시그널로 퍼져 나가는 뉴스 추적, 그리고 시장이 그 움직임을 이미 가격에 반영했는지에 대한 판단을 제공합니다.",
};
