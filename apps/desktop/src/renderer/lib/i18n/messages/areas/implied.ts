/**
 * Options-implied report move: the Earnings tab rows and drawer, and the
 * Stock tab earnings section (shared/implied-move.ts builds the lines). Same
 * rules as messages/en.ts: `{name}` placeholders kept in every language, and
 * no em dash or en dash anywhere (shared/copy-rules.ts). Every line says what
 * the options price and how the stock moved before; none advises or looks
 * ahead.
 */
export const en = {
  "implied.line.compare": "Options price a move of {pct} on this report; {ticker} moved more than that in {count} of its last {n} reports (median {median}).",
  "implied.line.few": "Options price a move of {pct} on this report. Past report moves on record: {n}, too few to compare.",
  "implied.line.alone": "Options price a move of {pct} on this report.",
  "implied.hint.straddle": "At the money straddle of the {expiry} expiry, strike {strike}, {basis}, against a share price of {spot}. Read {time}.",
  "implied.hint.mid": "mid quotes",
  "implied.hint.last": "last trades of the latest session",
  "implied.hint.adjusted": "The straddle alone prices {raw} to expiry; the ordinary move of the other {sessions} sessions, read from the {next} expiry, is taken out.",
  "implied.hint.history": "Past moves: the session that first traded each of the last {n} reports, close to close, {from} to {to}.",
  "implied.drawer.title": "Options before the report",
  "implied.drawer.move": "Implied move",
  "implied.drawer.above": "Past reports moving more",
  "implied.drawer.aboveValue": "{count} of {n}",
  "implied.drawer.median": "Median past move",
  "implied.drawer.sample": "Past reports on record",
} satisfies Record<string, string>;

type Table = Partial<Record<keyof typeof en, string>>;

export const tr: Table = {
  "implied.line.compare": "Opsiyonlar bu bilanço için {pct} hareket fiyatlıyor; {ticker}, son {n} bilançosunun {count} tanesinde bundan fazla hareket etti (medyan {median}).",
  "implied.line.few": "Opsiyonlar bu bilanço için {pct} hareket fiyatlıyor. Kayıtlı geçmiş bilanço hareketi: {n}, karşılaştırma için yetersiz.",
  "implied.line.alone": "Opsiyonlar bu bilanço için {pct} hareket fiyatlıyor.",
  "implied.hint.straddle": "{expiry} vadeli, {strike} kullanım fiyatlı başa baş straddle, {basis}; hisse fiyatı {spot}. Veri zamanı: {time}.",
  "implied.hint.mid": "alış satış ortası fiyatlar",
  "implied.hint.last": "son seansın son işlemleri",
  "implied.hint.adjusted": "Straddle tek başına vadeye kadar {raw} fiyatlıyor; diğer {sessions} seansın olağan hareketi, {next} vadesinden okunarak çıkarıldı.",
  "implied.hint.history": "Geçmiş hareketler: son {n} bilançonun her birini ilk fiyatlayan seans, kapanıştan kapanışa, {from} ile {to} arası.",
  "implied.drawer.title": "Bilanço öncesi opsiyonlar",
  "implied.drawer.move": "Fiyatlanan hareket",
  "implied.drawer.above": "Daha büyük hareketli geçmiş bilançolar",
  "implied.drawer.aboveValue": "{count} / {n}",
  "implied.drawer.median": "Geçmiş hareketlerin medyanı",
  "implied.drawer.sample": "Kayıtlı geçmiş bilançolar",
};

export const de: Table = {
  "implied.line.compare": "Optionen preisen für diesen Bericht eine Bewegung von {pct} ein; {ticker} bewegte sich bei {count} der letzten {n} Berichte stärker (Median {median}).",
  "implied.line.few": "Optionen preisen für diesen Bericht eine Bewegung von {pct} ein. Erfasste frühere Berichtsbewegungen: {n}, zu wenige für einen Vergleich.",
  "implied.line.alone": "Optionen preisen für diesen Bericht eine Bewegung von {pct} ein.",
  "implied.hint.straddle": "At the money Straddle des Verfalls {expiry}, Basispreis {strike}, {basis}, bei einem Aktienkurs von {spot}. Gelesen {time}.",
  "implied.hint.mid": "Mittelkurse",
  "implied.hint.last": "letzte Abschlüsse der jüngsten Sitzung",
  "implied.hint.adjusted": "Der Straddle allein preist {raw} bis zum Verfall ein; die gewöhnliche Bewegung der übrigen {sessions} Sitzungen, abgelesen am Verfall {next}, ist herausgerechnet.",
  "implied.hint.history": "Frühere Bewegungen: die Sitzung, die jeden der letzten {n} Berichte zuerst handelte, Schluss zu Schluss, {from} bis {to}.",
  "implied.drawer.title": "Optionen vor dem Bericht",
  "implied.drawer.move": "Eingepreiste Bewegung",
  "implied.drawer.above": "Frühere Berichte mit größerer Bewegung",
  "implied.drawer.aboveValue": "{count} von {n}",
  "implied.drawer.median": "Median früherer Bewegungen",
  "implied.drawer.sample": "Erfasste frühere Berichte",
};

export const fr: Table = {
  "implied.line.compare": "Les options intègrent un mouvement de {pct} sur cette publication ; {ticker} a davantage bougé lors de {count} de ses {n} dernières publications (médiane {median}).",
  "implied.line.few": "Les options intègrent un mouvement de {pct} sur cette publication. Mouvements passés enregistrés : {n}, trop peu pour comparer.",
  "implied.line.alone": "Les options intègrent un mouvement de {pct} sur cette publication.",
  "implied.hint.straddle": "Straddle à la monnaie de l'échéance du {expiry}, prix d'exercice {strike}, {basis}, pour un cours de {spot}. Lu le {time}.",
  "implied.hint.mid": "cours moyens",
  "implied.hint.last": "derniers échanges de la dernière séance",
  "implied.hint.adjusted": "Le straddle seul intègre {raw} jusqu'à l'échéance ; le mouvement ordinaire des {sessions} autres séances, lu sur l'échéance du {next}, est retiré.",
  "implied.hint.history": "Mouvements passés : la séance qui a d'abord traité chacune des {n} dernières publications, de clôture à clôture, du {from} au {to}.",
  "implied.drawer.title": "Options avant la publication",
  "implied.drawer.move": "Mouvement intégré",
  "implied.drawer.above": "Publications passées au mouvement plus fort",
  "implied.drawer.aboveValue": "{count} sur {n}",
  "implied.drawer.median": "Mouvement passé médian",
  "implied.drawer.sample": "Publications passées enregistrées",
};

export const es: Table = {
  "implied.line.compare": "Las opciones descuentan un movimiento del {pct} en este informe; {ticker} se movió más que eso en {count} de sus últimos {n} informes (mediana {median}).",
  "implied.line.few": "Las opciones descuentan un movimiento del {pct} en este informe. Movimientos pasados registrados: {n}, muy pocos para comparar.",
  "implied.line.alone": "Las opciones descuentan un movimiento del {pct} en este informe.",
  "implied.hint.straddle": "Straddle at the money del vencimiento del {expiry}, precio de ejercicio {strike}, {basis}, frente a un precio de la acción de {spot}. Leído {time}.",
  "implied.hint.mid": "precios medios",
  "implied.hint.last": "últimas operaciones de la última sesión",
  "implied.hint.adjusted": "El straddle solo descuenta {raw} hasta el vencimiento; se resta el movimiento ordinario de las otras {sessions} sesiones, leído del vencimiento del {next}.",
  "implied.hint.history": "Movimientos pasados: la sesión que negoció primero cada uno de los últimos {n} informes, de cierre a cierre, del {from} al {to}.",
  "implied.drawer.title": "Opciones antes del informe",
  "implied.drawer.move": "Movimiento descontado",
  "implied.drawer.above": "Informes pasados con mayor movimiento",
  "implied.drawer.aboveValue": "{count} de {n}",
  "implied.drawer.median": "Movimiento pasado mediano",
  "implied.drawer.sample": "Informes pasados registrados",
};

export const it: Table = {
  "implied.line.compare": "Le opzioni prezzano un movimento del {pct} su questa trimestrale; {ticker} si è mosso di più in {count} delle sue ultime {n} trimestrali (mediana {median}).",
  "implied.line.few": "Le opzioni prezzano un movimento del {pct} su questa trimestrale. Movimenti passati registrati: {n}, troppo pochi per un confronto.",
  "implied.line.alone": "Le opzioni prezzano un movimento del {pct} su questa trimestrale.",
  "implied.hint.straddle": "Straddle at the money della scadenza del {expiry}, strike {strike}, {basis}, a fronte di un prezzo dell'azione di {spot}. Letto {time}.",
  "implied.hint.mid": "prezzi medi",
  "implied.hint.last": "ultimi scambi dell'ultima seduta",
  "implied.hint.adjusted": "Lo straddle da solo prezza {raw} fino alla scadenza; il movimento ordinario delle altre {sessions} sedute, letto dalla scadenza del {next}, è sottratto.",
  "implied.hint.history": "Movimenti passati: la seduta che ha scambiato per prima ciascuna delle ultime {n} trimestrali, da chiusura a chiusura, dal {from} al {to}.",
  "implied.drawer.title": "Opzioni prima della trimestrale",
  "implied.drawer.move": "Movimento prezzato",
  "implied.drawer.above": "Trimestrali passate con movimento maggiore",
  "implied.drawer.aboveValue": "{count} su {n}",
  "implied.drawer.median": "Movimento passato mediano",
  "implied.drawer.sample": "Trimestrali passate registrate",
};

export const ptBR: Table = {
  "implied.line.compare": "As opções precificam um movimento de {pct} neste balanço; {ticker} se moveu mais do que isso em {count} dos seus últimos {n} balanços (mediana {median}).",
  "implied.line.few": "As opções precificam um movimento de {pct} neste balanço. Movimentos passados registrados: {n}, poucos para comparar.",
  "implied.line.alone": "As opções precificam um movimento de {pct} neste balanço.",
  "implied.hint.straddle": "Straddle no dinheiro do vencimento de {expiry}, strike {strike}, {basis}, contra um preço da ação de {spot}. Lido em {time}.",
  "implied.hint.mid": "preços médios",
  "implied.hint.last": "últimos negócios do pregão mais recente",
  "implied.hint.adjusted": "O straddle sozinho precifica {raw} até o vencimento; o movimento comum dos outros {sessions} pregões, lido do vencimento de {next}, foi retirado.",
  "implied.hint.history": "Movimentos passados: o pregão que primeiro negociou cada um dos últimos {n} balanços, de fechamento a fechamento, de {from} a {to}.",
  "implied.drawer.title": "Opções antes do balanço",
  "implied.drawer.move": "Movimento precificado",
  "implied.drawer.above": "Balanços passados com movimento maior",
  "implied.drawer.aboveValue": "{count} de {n}",
  "implied.drawer.median": "Movimento passado mediano",
  "implied.drawer.sample": "Balanços passados registrados",
};

export const ja: Table = {
  "implied.line.compare": "オプションはこの決算で{pct}の値動きを織り込んでいます。{ticker}は直近{n}回の決算のうち{count}回でそれを上回る値動きでした（中央値{median}）。",
  "implied.line.few": "オプションはこの決算で{pct}の値動きを織り込んでいます。記録にある過去の決算時の値動きは{n}回で、比較には足りません。",
  "implied.line.alone": "オプションはこの決算で{pct}の値動きを織り込んでいます。",
  "implied.hint.straddle": "{expiry}限月、権利行使価格{strike}のATMストラドル、{basis}、株価{spot}に対して。取得 {time}。",
  "implied.hint.mid": "仲値",
  "implied.hint.last": "直近の取引日の最終約定",
  "implied.hint.adjusted": "ストラドル単体では満期まで{raw}を織り込んでいます。{next}限月から読み取った残り{sessions}営業日の通常の値動きを差し引いています。",
  "implied.hint.history": "過去の値動き：直近{n}回の決算それぞれを最初に織り込んだ取引日の終値ベース、{from}から{to}まで。",
  "implied.drawer.title": "決算前のオプション",
  "implied.drawer.move": "織り込まれた値動き",
  "implied.drawer.above": "それを上回った過去の決算",
  "implied.drawer.aboveValue": "{n}回中{count}回",
  "implied.drawer.median": "過去の値動きの中央値",
  "implied.drawer.sample": "記録にある過去の決算",
};

export const zhCN: Table = {
  "implied.line.compare": "期权为本次财报计入了{pct}的波动；{ticker}在最近{n}次财报中有{count}次波动超过这一幅度（中位数{median}）。",
  "implied.line.few": "期权为本次财报计入了{pct}的波动。有记录的过去财报波动共{n}次，不足以比较。",
  "implied.line.alone": "期权为本次财报计入了{pct}的波动。",
  "implied.hint.straddle": "{expiry}到期、行权价{strike}的平值跨式组合，{basis}，对应股价{spot}。读取于{time}。",
  "implied.hint.mid": "买卖中间价",
  "implied.hint.last": "最近一个交易日的最后成交价",
  "implied.hint.adjusted": "跨式组合本身计入到期前{raw}的波动；已扣除从{next}到期合约读出的其余{sessions}个交易日的常规波动。",
  "implied.hint.history": "过去波动：最近{n}次财报各自首个交易日的收盘对收盘波动，{from}至{to}。",
  "implied.drawer.title": "财报前的期权",
  "implied.drawer.move": "计入的波动",
  "implied.drawer.above": "波动更大的过去财报",
  "implied.drawer.aboveValue": "{n}次中{count}次",
  "implied.drawer.median": "过去波动中位数",
  "implied.drawer.sample": "有记录的过去财报",
};

export const ko: Table = {
  "implied.line.compare": "옵션은 이번 실적 발표에 {pct}의 변동을 반영하고 있습니다. {ticker}는 최근 {n}번의 실적 발표 중 {count}번 그보다 크게 움직였습니다(중앙값 {median}).",
  "implied.line.few": "옵션은 이번 실적 발표에 {pct}의 변동을 반영하고 있습니다. 기록된 과거 실적 발표 변동은 {n}번으로 비교하기에 부족합니다.",
  "implied.line.alone": "옵션은 이번 실적 발표에 {pct}의 변동을 반영하고 있습니다.",
  "implied.hint.straddle": "{expiry} 만기, 행사가 {strike}의 등가격 스트래들, {basis}, 주가 {spot} 기준. 조회 {time}.",
  "implied.hint.mid": "중간 호가",
  "implied.hint.last": "가장 최근 거래일의 마지막 체결가",
  "implied.hint.adjusted": "스트래들만으로는 만기까지 {raw}를 반영합니다. {next} 만기에서 읽은 나머지 {sessions}거래일의 일반적인 변동을 뺐습니다.",
  "implied.hint.history": "과거 변동: 최근 {n}번의 실적 발표 각각을 처음 거래한 세션의 종가 대비 종가 변동, {from}부터 {to}까지.",
  "implied.drawer.title": "실적 발표 전 옵션",
  "implied.drawer.move": "반영된 변동",
  "implied.drawer.above": "더 크게 움직인 과거 실적 발표",
  "implied.drawer.aboveValue": "{n}번 중 {count}번",
  "implied.drawer.median": "과거 변동 중앙값",
  "implied.drawer.sample": "기록된 과거 실적 발표",
};
