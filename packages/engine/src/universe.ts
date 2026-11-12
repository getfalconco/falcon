/**
 * The sectors the engine watches (v0: semiconductors) and the plain names
 * cards show. Names are the ones people use, not the filing's legal casing.
 */

export const SECTORS: Record<string, { label: string; tickers: string[] }> = {
  semis: {
    label: "Semiconductors",
    tickers: [
      // Chips and IP
      "NVDA", "AMD", "AVGO", "INTC", "QCOM", "MU", "MRVL", "ARM", "TXN", "ADI", "ON", "MCHP", "NXPI", "STM",
      "LSCC", "MPWR", "SWKS", "QRVO", "CRUS", "SITM", "SLAB", "SYNA", "MTSI", "ALGM", "AMBA", "RMBS", "ALAB",
      "CRDO", "WOLF", "POWI", "DIOD", "SMTC", "MXL",
      // Foundries and assembly
      "TSM", "GFS", "UMC", "ASX", "AMKR",
      // Equipment, process control, design software
      "ASML", "AMAT", "LRCX", "KLAC", "TER", "ENTG", "ONTO", "NVMI", "CAMT", "FORM", "COHU", "ACLS", "UCTT",
      "ICHR", "SNPS", "CDNS",
      // Systems and optics closest to the chips
      "SMCI", "COHR", "LITE", "ANET",
    ],
  },
};

export const NAMES: Record<string, string> = {
  AAPL: "Apple",
  ACLS: "Axcelis",
  ADI: "Analog Devices",
  ALAB: "Astera Labs",
  ALGM: "Allegro MicroSystems",
  AMAT: "Applied Materials",
  AMBA: "Ambarella",
  AMD: "AMD",
  AMKR: "Amkor",
  AMZN: "Amazon",
  ANET: "Arista Networks",
  APTV: "Aptiv",
  ARM: "Arm",
  ARW: "Arrow Electronics",
  ASML: "ASML",
  ASX: "ASE Technology",
  AVGO: "Broadcom",
  AVT: "Avnet",
  BABA: "Alibaba",
  CAMT: "Camtek",
  CDNS: "Cadence",
  CEVA: "CEVA",
  COHR: "Coherent",
  COHU: "Cohu",
  CRDO: "Credo",
  CRUS: "Cirrus Logic",
  CSCO: "Cisco",
  DIOD: "Diodes",
  ENTG: "Entegris",
  FN: "Fabrinet",
  FORM: "FormFactor",
  GFS: "GlobalFoundries",
  GOOGL: "Alphabet",
  HNHPF: "Foxconn",
  HPE: "Hewlett Packard Enterprise",
  HXSCL: "SK hynix",
  ICHR: "Ichor",
  IFNNY: "Infineon",
  INTC: "Intel",
  KEYS: "Keysight",
  KLAC: "KLA",
  LITE: "Lumentum",
  LRCX: "Lam Research",
  LSCC: "Lattice Semiconductor",
  MBLY: "Mobileye",
  MCHP: "Microchip",
  META: "Meta",
  MPWR: "Monolithic Power",
  MRVL: "Marvell",
  MSFT: "Microsoft",
  MTSI: "MACOM",
  MU: "Micron",
  MXL: "MaxLinear",
  NVDA: "NVIDIA",
  NVMI: "Nova",
  NXPI: "NXP",
  ON: "onsemi",
  ONTO: "Onto Innovation",
  PDFS: "PDF Solutions",
  POWI: "Power Integrations",
  QCOM: "Qualcomm",
  QRVO: "Qorvo",
  RMBS: "Rambus",
  SITM: "SiTime",
  SLAB: "Silicon Labs",
  SMCI: "Supermicro",
  SMTC: "Semtech",
  SNPS: "Synopsys",
  SONY: "Sony",
  STM: "STMicroelectronics",
  SWKS: "Skyworks",
  SYNA: "Synaptics",
  TER: "Teradyne",
  TSLA: "Tesla",
  TSM: "TSMC",
  TXN: "Texas Instruments",
  UCTT: "Ultra Clean",
  UMC: "UMC",
  VC: "Visteon",
  WOLF: "Wolfspeed",
};

export function sectorTickers(sector: string): string[] {
  const s = SECTORS[sector];
  if (!s) throw new Error(`unknown sector "${sector}" (known: ${Object.keys(SECTORS).join(", ")})`);
  return s.tickers;
}
