/**
 * The Allocation card (components/dashboard/AllocationCard.tsx): the book by
 * kind of holding, on a gauge, with the reader's planned split beside it.
 * Kept in its own area file so it can change while other areas are being
 * edited. Same rules as messages/en.ts: `{name}` placeholders kept in every
 * language, and no em dash or en dash anywhere (shared/copy-rules.ts). The
 * planned split is a "plan", never a "target": that word is on the advice
 * list.
 */
export const en = {
  "modules.allocation": "Allocation",

  "allocation.card.label": "ALLOCATION",
  "allocation.invested": "invested",
  "allocation.gauge": "{invested}% invested, {cash}% cash",
  "allocation.empty":
    "No account linked yet. Connect a brokerage or open a Falcon paper account to see how your book is split.",
  "allocation.nothing": "No holdings and no cash in the account yet.",

  "allocation.class.stocks": "Stocks",
  "allocation.class.funds": "ETFs and funds",
  "allocation.class.crypto": "Crypto",
  "allocation.class.options": "Options",
  "allocation.class.linked": "Linked accounts",
  "allocation.class.other": "Other",
  "allocation.class.cash": "Cash",

  "allocation.plan.pill": "Plan {invested}/{cash}",
  "allocation.plan.set": "Set plan",
  "allocation.plan.change": "Change the planned split, now {invested}% invested and {cash}% cash",
  "allocation.plan.setAria": "Set a planned split between invested and cash",
  "allocation.plan.input": "Planned invested share, in percent. Leave it empty to clear the plan.",
} satisfies Record<string, string>;

type Table = Partial<Record<keyof typeof en, string>>;

export const tr: Table = {
  "modules.allocation": "Dağılım",

  "allocation.card.label": "DAĞILIM",
  "allocation.invested": "yatırımda",
  "allocation.gauge": "%{invested} yatırımda, %{cash} nakit",
  "allocation.empty":
    "Henüz bağlı bir hesap yok. Portföyünüzün nasıl dağıldığını görmek için bir aracı kurum bağlayın ya da bir Falcon sanal hesabı açın.",
  "allocation.nothing": "Hesapta henüz varlık ya da nakit yok.",

  "allocation.class.stocks": "Hisseler",
  "allocation.class.funds": "ETF ve fonlar",
  "allocation.class.crypto": "Kripto",
  "allocation.class.options": "Opsiyonlar",
  "allocation.class.linked": "Bağlı hesaplar",
  "allocation.class.other": "Diğer",
  "allocation.class.cash": "Nakit",

  "allocation.plan.pill": "Plan {invested}/{cash}",
  "allocation.plan.set": "Plan belirle",
  "allocation.plan.change": "Planlanan dağılımı değiştir, şu an %{invested} yatırımda ve %{cash} nakit",
  "allocation.plan.setAria": "Yatırım ile nakit arasında planlanan bir dağılım belirle",
  "allocation.plan.input": "Yatırımda tutulması planlanan pay, yüzde olarak. Planı silmek için boş bırakın.",
};

export const de: Table = {
  "modules.allocation": "Aufteilung",

  "allocation.card.label": "AUFTEILUNG",
  "allocation.invested": "investiert",
  "allocation.gauge": "{invested} % investiert, {cash} % Barmittel",
  "allocation.empty":
    "Noch kein Konto verknüpft. Verbinden Sie einen Broker oder eröffnen Sie ein Falcon-Papierkonto, um zu sehen, wie Ihr Depot aufgeteilt ist.",
  "allocation.nothing": "Noch keine Bestände und kein Bargeld im Konto.",

  "allocation.class.stocks": "Aktien",
  "allocation.class.funds": "ETFs und Fonds",
  "allocation.class.crypto": "Krypto",
  "allocation.class.options": "Optionen",
  "allocation.class.linked": "Verknüpfte Konten",
  "allocation.class.other": "Sonstige",
  "allocation.class.cash": "Barmittel",

  "allocation.plan.pill": "Plan {invested}/{cash}",
  "allocation.plan.set": "Plan festlegen",
  "allocation.plan.change": "Geplante Aufteilung ändern, derzeit {invested} % investiert und {cash} % Barmittel",
  "allocation.plan.setAria": "Eine geplante Aufteilung zwischen investiert und Barmitteln festlegen",
  "allocation.plan.input": "Geplanter investierter Anteil in Prozent. Leer lassen, um den Plan zu löschen.",
};

export const fr: Table = {
  "modules.allocation": "Répartition",

  "allocation.card.label": "RÉPARTITION",
  "allocation.invested": "investi",
  "allocation.gauge": "{invested} % investi, {cash} % en liquidités",
  "allocation.empty":
    "Aucun compte lié pour l'instant. Connectez un courtier ou ouvrez un compte fictif Falcon pour voir la répartition de votre portefeuille.",
  "allocation.nothing": "Aucune position et aucune liquidité dans le compte pour l'instant.",

  "allocation.class.stocks": "Actions",
  "allocation.class.funds": "ETF et fonds",
  "allocation.class.crypto": "Crypto",
  "allocation.class.options": "Options",
  "allocation.class.linked": "Comptes liés",
  "allocation.class.other": "Autres",
  "allocation.class.cash": "Liquidités",

  "allocation.plan.pill": "Plan {invested}/{cash}",
  "allocation.plan.set": "Définir un plan",
  "allocation.plan.change": "Modifier la répartition prévue, actuellement {invested} % investi et {cash} % en liquidités",
  "allocation.plan.setAria": "Définir une répartition prévue entre investi et liquidités",
  "allocation.plan.input": "Part investie prévue, en pourcentage. Laissez le champ vide pour effacer le plan.",
};

export const es: Table = {
  "modules.allocation": "Distribución",

  "allocation.card.label": "DISTRIBUCIÓN",
  "allocation.invested": "invertido",
  "allocation.gauge": "{invested} % invertido, {cash} % en efectivo",
  "allocation.empty":
    "Aún no hay ninguna cuenta vinculada. Conecte un bróker o abra una cuenta simulada de Falcon para ver cómo se distribuye su cartera.",
  "allocation.nothing": "Todavía no hay posiciones ni efectivo en la cuenta.",

  "allocation.class.stocks": "Acciones",
  "allocation.class.funds": "ETF y fondos",
  "allocation.class.crypto": "Cripto",
  "allocation.class.options": "Opciones",
  "allocation.class.linked": "Cuentas vinculadas",
  "allocation.class.other": "Otros",
  "allocation.class.cash": "Efectivo",

  "allocation.plan.pill": "Plan {invested}/{cash}",
  "allocation.plan.set": "Fijar un plan",
  "allocation.plan.change": "Cambiar la distribución prevista, ahora {invested} % invertido y {cash} % en efectivo",
  "allocation.plan.setAria": "Fijar una distribución prevista entre invertido y efectivo",
  "allocation.plan.input": "Parte invertida prevista, en porcentaje. Déjelo vacío para borrar el plan.",
};

export const it: Table = {
  "modules.allocation": "Ripartizione",

  "allocation.card.label": "RIPARTIZIONE",
  "allocation.invested": "investito",
  "allocation.gauge": "{invested}% investito, {cash}% in liquidità",
  "allocation.empty":
    "Nessun conto collegato. Collegate un broker o aprite un conto simulato Falcon per vedere come è ripartito il portafoglio.",
  "allocation.nothing": "Ancora nessuna posizione e nessuna liquidità nel conto.",

  "allocation.class.stocks": "Azioni",
  "allocation.class.funds": "ETF e fondi",
  "allocation.class.crypto": "Cripto",
  "allocation.class.options": "Opzioni",
  "allocation.class.linked": "Conti collegati",
  "allocation.class.other": "Altro",
  "allocation.class.cash": "Liquidità",

  "allocation.plan.pill": "Piano {invested}/{cash}",
  "allocation.plan.set": "Imposta un piano",
  "allocation.plan.change": "Cambia la ripartizione prevista, ora {invested}% investito e {cash}% in liquidità",
  "allocation.plan.setAria": "Imposta una ripartizione prevista tra investito e liquidità",
  "allocation.plan.input": "Quota investita prevista, in percentuale. Lasciate vuoto per cancellare il piano.",
};

export const ptBR: Table = {
  "modules.allocation": "Alocação",

  "allocation.card.label": "ALOCAÇÃO",
  "allocation.invested": "investido",
  "allocation.gauge": "{invested}% investido, {cash}% em caixa",
  "allocation.empty":
    "Nenhuma conta vinculada ainda. Conecte uma corretora ou abra uma conta simulada Falcon para ver como sua carteira está dividida.",
  "allocation.nothing": "Ainda não há posições nem caixa na conta.",

  "allocation.class.stocks": "Ações",
  "allocation.class.funds": "ETFs e fundos",
  "allocation.class.crypto": "Cripto",
  "allocation.class.options": "Opções",
  "allocation.class.linked": "Contas vinculadas",
  "allocation.class.other": "Outros",
  "allocation.class.cash": "Caixa",

  "allocation.plan.pill": "Plano {invested}/{cash}",
  "allocation.plan.set": "Definir plano",
  "allocation.plan.change": "Alterar a divisão planejada, agora {invested}% investido e {cash}% em caixa",
  "allocation.plan.setAria": "Definir uma divisão planejada entre investido e caixa",
  "allocation.plan.input": "Parcela investida planejada, em porcentagem. Deixe vazio para apagar o plano.",
};

export const ja: Table = {
  "modules.allocation": "配分",

  "allocation.card.label": "配分",
  "allocation.invested": "投資中",
  "allocation.gauge": "投資中 {invested}%、現金 {cash}%",
  "allocation.empty":
    "まだ口座が連携されていません。証券会社を接続するか、Falcon の仮想口座を開設すると、ポートフォリオの配分がここに表示されます。",
  "allocation.nothing": "口座にはまだ保有銘柄も現金もありません。",

  "allocation.class.stocks": "株式",
  "allocation.class.funds": "ETF・ファンド",
  "allocation.class.crypto": "暗号資産",
  "allocation.class.options": "オプション",
  "allocation.class.linked": "連携口座",
  "allocation.class.other": "その他",
  "allocation.class.cash": "現金",

  "allocation.plan.pill": "計画 {invested}/{cash}",
  "allocation.plan.set": "計画を設定",
  "allocation.plan.change": "計画した配分を変更 (現在は投資中 {invested}%、現金 {cash}%)",
  "allocation.plan.setAria": "投資と現金の計画配分を設定",
  "allocation.plan.input": "投資に回す予定の割合 (%)。空欄にすると計画を消去します。",
};

export const zhCN: Table = {
  "modules.allocation": "资产配置",

  "allocation.card.label": "资产配置",
  "allocation.invested": "已投资",
  "allocation.gauge": "已投资 {invested}%，现金 {cash}%",
  "allocation.empty": "尚未关联任何账户。连接券商或开设 Falcon 模拟账户，即可查看投资组合的配置。",
  "allocation.nothing": "账户中尚无持仓，也没有现金。",

  "allocation.class.stocks": "股票",
  "allocation.class.funds": "ETF 与基金",
  "allocation.class.crypto": "加密货币",
  "allocation.class.options": "期权",
  "allocation.class.linked": "关联账户",
  "allocation.class.other": "其他",
  "allocation.class.cash": "现金",

  "allocation.plan.pill": "计划 {invested}/{cash}",
  "allocation.plan.set": "设定计划",
  "allocation.plan.change": "更改计划配置，当前已投资 {invested}%，现金 {cash}%",
  "allocation.plan.setAria": "设定投资与现金之间的计划配置",
  "allocation.plan.input": "计划投资比例（百分比）。留空即可清除计划。",
};

export const ko: Table = {
  "modules.allocation": "자산 배분",

  "allocation.card.label": "자산 배분",
  "allocation.invested": "투자 중",
  "allocation.gauge": "투자 중 {invested}%, 현금 {cash}%",
  "allocation.empty":
    "아직 연결된 계좌가 없습니다. 증권사를 연결하거나 Falcon 모의 계좌를 개설하면 포트폴리오가 어떻게 나뉘어 있는지 볼 수 있습니다.",
  "allocation.nothing": "계좌에 아직 보유 자산도 현금도 없습니다.",

  "allocation.class.stocks": "주식",
  "allocation.class.funds": "ETF 및 펀드",
  "allocation.class.crypto": "암호화폐",
  "allocation.class.options": "옵션",
  "allocation.class.linked": "연결된 계좌",
  "allocation.class.other": "기타",
  "allocation.class.cash": "현금",

  "allocation.plan.pill": "계획 {invested}/{cash}",
  "allocation.plan.set": "계획 설정",
  "allocation.plan.change": "계획한 배분 변경, 현재 투자 중 {invested}%, 현금 {cash}%",
  "allocation.plan.setAria": "투자와 현금 사이의 계획 배분 설정",
  "allocation.plan.input": "투자할 계획인 비율(%). 비워 두면 계획이 지워집니다.",
};
