/**
 * Form 4 ownership XML for tests, shaped like EDGAR's (schema X0508): the
 * tags, nesting and footnote references a real filing carries, with made-up
 * people and figures.
 */

export type FixtureLine = {
  code: string;
  date: string;
  shares: number;
  price?: number | null;
  ad?: "A" | "D";
  after?: number | null;
  ownership?: "D" | "I";
  nature?: string;
  footnotes?: string[];
};

export type FixtureForm = {
  issuerCik?: string;
  ownerCik?: string;
  ownerName?: string;
  title?: string | null;
  director?: boolean;
  tenPercent?: boolean;
  aff10b5One?: boolean;
  lines?: FixtureLine[];
  derivative?: FixtureLine[];
  holdings?: Array<{ shares: number; ownership?: "D" | "I"; nature?: string }>;
  footnotes?: Record<string, string>;
};

function v(name: string, value: string | number | null | undefined, refs: string[] = []): string {
  const notes = refs.map((id) => `<footnoteId id="${id}"/>`).join("");
  return value === null || value === undefined ? `<${name}>${notes}</${name}>` : `<${name}><value>${value}</value>${notes}</${name}>`;
}

function line(l: FixtureLine, derivative: boolean): string {
  const tagName = derivative ? "derivativeTransaction" : "nonDerivativeTransaction";
  const ad = l.ad ?? (l.code === "S" || l.code === "F" ? "D" : "A");
  return `<${tagName}>
      ${v("securityTitle", derivative ? "Stock Option (Right to Buy)" : "Common Stock")}
      ${derivative ? v("conversionOrExercisePrice", 50) : ""}
      ${v("transactionDate", l.date)}
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${l.code}</transactionCode><equitySwapInvolved>0</equitySwapInvolved>${(l.footnotes ?? []).map((id) => `<footnoteId id="${id}"/>`).join("")}</transactionCoding>
      <transactionAmounts>
        ${v("transactionShares", l.shares)}
        ${v("transactionPricePerShare", l.price === undefined ? 100 : l.price)}
        ${v("transactionAcquiredDisposedCode", ad)}
      </transactionAmounts>
      ${derivative ? `<underlyingSecurity>${v("underlyingSecurityTitle", "Common Stock")}${v("underlyingSecurityShares", l.shares)}</underlyingSecurity>` : ""}
      <postTransactionAmounts>${v("sharesOwnedFollowingTransaction", l.after === undefined ? 10_000 : l.after)}</postTransactionAmounts>
      <ownershipNature>${v("directOrIndirectOwnership", l.ownership ?? "D")}${l.nature ? v("natureOfOwnership", l.nature) : ""}</ownershipNature>
    </${tagName}>`;
}

export function form4Xml(f: FixtureForm = {}): string {
  const notes = Object.entries(f.footnotes ?? {})
    .map(([id, text]) => `<footnote id="${id}">${text}</footnote>`)
    .join("\n    ");
  return `<?xml version="1.0"?>
<ownershipDocument>
  <schemaVersion>X0508</schemaVersion>
  <documentType>4</documentType>
  <periodOfReport>${f.lines?.[0]?.date ?? "2026-10-01"}</periodOfReport>
  <aff10b5One>${f.aff10b5One ? 1 : 0}</aff10b5One>
  <issuer><issuerCik>${f.issuerCik ?? "0001234567"}</issuerCik><issuerName>EXAMPLE CORP</issuerName><issuerTradingSymbol>EXMP</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>${f.ownerCik ?? "0009000001"}</rptOwnerCik><rptOwnerName>${f.ownerName ?? "Doe Jane"}</rptOwnerName></reportingOwnerId>
    <reportingOwnerAddress><rptOwnerStreet1>1 Main St</rptOwnerStreet1></reportingOwnerAddress>
    <reportingOwnerRelationship>
      <isDirector>${f.director ? 1 : 0}</isDirector>
      <isOfficer>${f.title ? 1 : 0}</isOfficer>
      <isTenPercentOwner>${f.tenPercent ? 1 : 0}</isTenPercentOwner>
      <isOther>0</isOther>
      ${f.title ? `<officerTitle>${f.title}</officerTitle>` : ""}
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    ${(f.lines ?? []).map((l) => line(l, false)).join("\n    ")}
    ${(f.holdings ?? [])
      .map(
        (h) => `<nonDerivativeHolding>${v("securityTitle", "Common Stock")}<postTransactionAmounts>${v("sharesOwnedFollowingTransaction", h.shares)}</postTransactionAmounts><ownershipNature>${v("directOrIndirectOwnership", h.ownership ?? "I")}${h.nature ? v("natureOfOwnership", h.nature) : ""}</ownershipNature></nonDerivativeHolding>`,
      )
      .join("\n    ")}
  </nonDerivativeTable>
  <derivativeTable>
    ${(f.derivative ?? []).map((l) => line(l, true)).join("\n    ")}
  </derivativeTable>
  <footnotes>
    ${notes}
  </footnotes>
  <remarks></remarks>
  <ownerSignature><signatureName>/s/ Attorney in fact</signatureName><signatureDate>2026-10-02</signatureDate></ownerSignature>
</ownershipDocument>`;
}
