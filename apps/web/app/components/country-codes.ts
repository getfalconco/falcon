// ISO 3166-1 alpha-2 → E.164 dial code, for the phone field on the early
// access form. Flags are pulled from flagcdn by the same ISO code (emoji flags
// have no glyphs on Windows). NANP entries carry their area code so the number
// typed next to them stays local.
const RAW = `
af|Afghanistan|93
ax|Åland Islands|358
al|Albania|355
dz|Algeria|213
as|American Samoa|1 684
ad|Andorra|376
ao|Angola|244
ai|Anguilla|1 264
ag|Antigua and Barbuda|1 268
ar|Argentina|54
am|Armenia|374
aw|Aruba|297
au|Australia|61
at|Austria|43
az|Azerbaijan|994
bs|Bahamas|1 242
bh|Bahrain|973
bd|Bangladesh|880
bb|Barbados|1 246
by|Belarus|375
be|Belgium|32
bz|Belize|501
bj|Benin|229
bm|Bermuda|1 441
bt|Bhutan|975
bo|Bolivia|591
bq|Caribbean Netherlands|599
ba|Bosnia and Herzegovina|387
bw|Botswana|267
br|Brazil|55
io|British Indian Ocean Territory|246
vg|British Virgin Islands|1 284
bn|Brunei|673
bg|Bulgaria|359
bf|Burkina Faso|226
bi|Burundi|257
kh|Cambodia|855
cm|Cameroon|237
ca|Canada|1
cv|Cape Verde|238
ky|Cayman Islands|1 345
cf|Central African Republic|236
td|Chad|235
cl|Chile|56
cn|China|86
cx|Christmas Island|61
cc|Cocos (Keeling) Islands|61
co|Colombia|57
km|Comoros|269
ck|Cook Islands|682
cr|Costa Rica|506
ci|Côte d'Ivoire|225
hr|Croatia|385
cu|Cuba|53
cw|Curaçao|599
cy|Cyprus|357
cz|Czechia|420
cd|DR Congo|243
dk|Denmark|45
dj|Djibouti|253
dm|Dominica|1 767
do|Dominican Republic|1 809
ec|Ecuador|593
eg|Egypt|20
sv|El Salvador|503
gq|Equatorial Guinea|240
er|Eritrea|291
ee|Estonia|372
sz|Eswatini|268
et|Ethiopia|251
fk|Falkland Islands|500
fo|Faroe Islands|298
fj|Fiji|679
fi|Finland|358
fr|France|33
gf|French Guiana|594
pf|French Polynesia|689
ga|Gabon|241
gm|Gambia|220
ge|Georgia|995
de|Germany|49
gh|Ghana|233
gi|Gibraltar|350
gr|Greece|30
gl|Greenland|299
gd|Grenada|1 473
gp|Guadeloupe|590
gu|Guam|1 671
gt|Guatemala|502
gg|Guernsey|44
gn|Guinea|224
gw|Guinea-Bissau|245
gy|Guyana|592
ht|Haiti|509
hn|Honduras|504
hk|Hong Kong|852
hu|Hungary|36
is|Iceland|354
in|India|91
id|Indonesia|62
ir|Iran|98
iq|Iraq|964
ie|Ireland|353
im|Isle of Man|44
il|Israel|972
it|Italy|39
jm|Jamaica|1 876
jp|Japan|81
je|Jersey|44
jo|Jordan|962
kz|Kazakhstan|7
ke|Kenya|254
ki|Kiribati|686
xk|Kosovo|383
kw|Kuwait|965
kg|Kyrgyzstan|996
la|Laos|856
lv|Latvia|371
lb|Lebanon|961
ls|Lesotho|266
lr|Liberia|231
ly|Libya|218
li|Liechtenstein|423
lt|Lithuania|370
lu|Luxembourg|352
mo|Macao|853
mg|Madagascar|261
mw|Malawi|265
my|Malaysia|60
mv|Maldives|960
ml|Mali|223
mt|Malta|356
mh|Marshall Islands|692
mq|Martinique|596
mr|Mauritania|222
mu|Mauritius|230
yt|Mayotte|262
mx|Mexico|52
fm|Micronesia|691
md|Moldova|373
mc|Monaco|377
mn|Mongolia|976
me|Montenegro|382
ms|Montserrat|1 664
ma|Morocco|212
mz|Mozambique|258
mm|Myanmar|95
na|Namibia|264
nr|Nauru|674
np|Nepal|977
nl|Netherlands|31
nc|New Caledonia|687
nz|New Zealand|64
ni|Nicaragua|505
ne|Niger|227
ng|Nigeria|234
nu|Niue|683
nf|Norfolk Island|672
kp|North Korea|850
mk|North Macedonia|389
mp|Northern Mariana Islands|1 670
no|Norway|47
om|Oman|968
pk|Pakistan|92
pw|Palau|680
ps|Palestine|970
pa|Panama|507
pg|Papua New Guinea|675
py|Paraguay|595
pe|Peru|51
ph|Philippines|63
pl|Poland|48
pt|Portugal|351
pr|Puerto Rico|1 787
qa|Qatar|974
cg|Republic of the Congo|242
re|Réunion|262
ro|Romania|40
ru|Russia|7
rw|Rwanda|250
bl|Saint Barthélemy|590
sh|Saint Helena|290
kn|Saint Kitts and Nevis|1 869
lc|Saint Lucia|1 758
mf|Saint Martin|590
pm|Saint Pierre and Miquelon|508
vc|Saint Vincent and the Grenadines|1 784
ws|Samoa|685
sm|San Marino|378
st|São Tomé and Príncipe|239
sa|Saudi Arabia|966
sn|Senegal|221
rs|Serbia|381
sc|Seychelles|248
sl|Sierra Leone|232
sg|Singapore|65
sx|Sint Maarten|1 721
sk|Slovakia|421
si|Slovenia|386
sb|Solomon Islands|677
so|Somalia|252
za|South Africa|27
kr|South Korea|82
ss|South Sudan|211
es|Spain|34
lk|Sri Lanka|94
sd|Sudan|249
sr|Suriname|597
sj|Svalbard and Jan Mayen|47
se|Sweden|46
ch|Switzerland|41
sy|Syria|963
tw|Taiwan|886
tj|Tajikistan|992
tz|Tanzania|255
th|Thailand|66
tl|Timor-Leste|670
tg|Togo|228
tk|Tokelau|690
to|Tonga|676
tt|Trinidad and Tobago|1 868
tn|Tunisia|216
tr|Türkiye|90
tm|Turkmenistan|993
tc|Turks and Caicos Islands|1 649
tv|Tuvalu|688
ug|Uganda|256
ua|Ukraine|380
ae|United Arab Emirates|971
gb|United Kingdom|44
us|United States|1
uy|Uruguay|598
uz|Uzbekistan|998
vu|Vanuatu|678
va|Vatican City|39
ve|Venezuela|58
vn|Vietnam|84
wf|Wallis and Futuna|681
eh|Western Sahara|212
ye|Yemen|967
zm|Zambia|260
zw|Zimbabwe|263
`;

// Grouping patterns for the places most applicants come from; "#" is a digit
// slot, everything else is punctuation the field types for you. Numbers are
// national significant numbers — the trunk "0" is never part of them, because
// the dial code already sits to the left of the field.
const FORMATS: Record<string, string> = {
  us: "(###) ###-####",
  ca: "(###) ###-####",
  gb: "#### ######",
  tr: "### ### ## ##",
  de: "### ########",
  fr: "# ## ## ## ##",
  nl: "# ########",
  ch: "## ### ## ##",
  ae: "## ### ####",
  au: "### ### ###",
  sg: "#### ####",
  hk: "#### ####",
  jp: "## #### ####",
  in: "##### #####",
  br: "## #####-####",
  za: "## ### ####",
  es: "### ### ###",
  it: "### ### ####",
  ru: "### ###-##-##",
  kz: "### ###-##-##",
  ua: "## ### ## ##",
  pl: "### ### ###",
  se: "##-### ## ##",
  no: "### ## ###",
  dk: "## ## ## ##",
  fi: "## ### ####",
  be: "### ## ## ##",
  at: "### ######",
  pt: "### ### ###",
  gr: "### ### ####",
  ie: "## ### ####",
  nz: "## ### ####",
  mx: "## #### ####",
  ar: "## ####-####",
  cn: "### #### ####",
  kr: "## #### ####",
  id: "###-###-####",
  my: "##-### ####",
  th: "## ### ####",
  ph: "### ### ####",
  vn: "### ### ####",
  sa: "## ### ####",
  il: "##-###-####",
  ng: "### ### ####",
  ke: "### ######",
  eg: "## #### ####",
  pk: "### #######",
  bd: "#### ######",
};

// Example national numbers, digits only. The placeholder is rendered through
// the same formatter, so the hint can never drift from what typing produces.
const SAMPLE_DIGITS: Record<string, string> = {
  us: "2015550123",
  ca: "4165550123",
  gb: "7400123456",
  tr: "5321234567",
  de: "15123456789",
  fr: "612345678",
  nl: "612345678",
  ch: "781234567",
  ae: "501234567",
  au: "412345678",
  sg: "81234567",
  hk: "51234567",
  jp: "9012345678",
  in: "8123456789",
  br: "11961234567",
  za: "711234567",
};

// Italy (and the Vatican, which shares its plan) is the one place where the
// leading zero belongs to the number itself.
const KEEPS_LEADING_ZERO = new Set(["it", "va"]);

/** Digits only, trunk zero dropped and length capped to E.164's 15. */
export function normalizePhoneDigits(iso: string, input: string): string {
  let digits = input.replace(/\D/g, "");
  if (!KEEPS_LEADING_ZERO.has(iso)) digits = digits.replace(/^0+/, "");
  return digits.slice(0, 15);
}

/** Types the country's punctuation in as the digits arrive. */
export function formatPhone(iso: string, input: string): string {
  const digits = normalizePhoneDigits(iso, input);
  if (!digits) return "";

  const pattern = FORMATS[iso];
  if (!pattern) {
    // No pattern on file: plain groups of three still beats one long run.
    return (digits.match(/.{1,3}/g) ?? []).join(" ");
  }

  let out = "";
  let i = 0;
  for (const slot of pattern) {
    if (i >= digits.length) break;
    if (slot === "#") {
      out += digits[i];
      i += 1;
    } else {
      out += slot;
    }
  }
  // Anything past the pattern (long numbers, wrong country) keeps flowing.
  return i < digits.length ? `${out} ${digits.slice(i)}` : out;
}

export type Country = {
  iso: string;
  name: string;
  /** E.164 prefix, already formatted for display (e.g. "+1 264"). */
  dial: string;
  /** Placeholder shown in the number field. */
  sample: string;
};

export const COUNTRIES: Country[] = RAW.trim()
  .split("\n")
  .map((line) => {
    const [iso, name, dial] = line.split("|");
    const digits = SAMPLE_DIGITS[iso];
    return {
      iso,
      name,
      dial: `+${dial}`,
      sample: digits ? formatPhone(iso, digits) : "Phone number",
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name, "en"));

export const DEFAULT_COUNTRY_ISO = "us";
