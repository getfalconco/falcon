/**
 * Staff-only engine controls. The engine service refuses the switches and
 * run buttons that change the shared chain for every account unless the
 * caller is Falcon staff; the app disables those controls for everyone else
 * and says why in one line. Same rules as messages/en.ts: `{name}`
 * placeholders kept in every language, and no em dash or en dash anywhere
 * (shared/copy-rules.ts).
 */
export const en = {
  "access.staffOnly.setting": "Only Falcon staff can change this. It applies to every account.",
  "access.staffOnly.action": "Only Falcon staff can run this. It runs for every account.",
} satisfies Record<string, string>;

type Table = Partial<Record<keyof typeof en, string>>;

export const tr: Table = {
  "access.staffOnly.setting": "Bunu yalnızca Falcon ekibi değiştirebilir. Tüm hesaplar için geçerlidir.",
  "access.staffOnly.action": "Bunu yalnızca Falcon ekibi çalıştırabilir. Tüm hesaplar için çalışır.",
};

export const de: Table = {
  "access.staffOnly.setting": "Nur das Falcon-Team kann das ändern. Es gilt für alle Konten.",
  "access.staffOnly.action": "Nur das Falcon-Team kann das ausführen. Es läuft für alle Konten.",
};

export const fr: Table = {
  "access.staffOnly.setting": "Seule l'équipe Falcon peut modifier ce réglage. Il s'applique à tous les comptes.",
  "access.staffOnly.action": "Seule l'équipe Falcon peut lancer cette action. Elle s'exécute pour tous les comptes.",
};

export const es: Table = {
  "access.staffOnly.setting": "Solo el equipo de Falcon puede cambiar esto. Se aplica a todas las cuentas.",
  "access.staffOnly.action": "Solo el equipo de Falcon puede ejecutar esto. Se ejecuta para todas las cuentas.",
};

export const it: Table = {
  "access.staffOnly.setting": "Solo il team di Falcon può modificarlo. Vale per tutti gli account.",
  "access.staffOnly.action": "Solo il team di Falcon può avviarlo. Viene eseguito per tutti gli account.",
};

export const ptBR: Table = {
  "access.staffOnly.setting": "Só a equipe da Falcon pode alterar isto. Vale para todas as contas.",
  "access.staffOnly.action": "Só a equipe da Falcon pode executar isto. É executado para todas as contas.",
};

export const ja: Table = {
  "access.staffOnly.setting": "これを変更できるのは Falcon のスタッフだけです。すべてのアカウントに適用されます。",
  "access.staffOnly.action": "これを実行できるのは Falcon のスタッフだけです。すべてのアカウントに対して実行されます。",
};

export const zhCN: Table = {
  "access.staffOnly.setting": "只有 Falcon 团队成员可以更改此项。它适用于所有账户。",
  "access.staffOnly.action": "只有 Falcon 团队成员可以运行此项。它会为所有账户运行。",
};

export const ko: Table = {
  "access.staffOnly.setting": "Falcon 스태프만 변경할 수 있습니다. 모든 계정에 적용됩니다.",
  "access.staffOnly.action": "Falcon 스태프만 실행할 수 있습니다. 모든 계정에 대해 실행됩니다.",
};
