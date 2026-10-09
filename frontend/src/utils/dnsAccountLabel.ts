export interface DnsAccountIdentity {
  id: number;
  name?: string;
  account_id?: string | null;
  credential_id?: number;
  credential_name?: string;
}

/** Use the name shown in Credential management, joined by ID rather than inferred from Account names. */
export function dnsAccountLabel(account: DnsAccountIdentity, credentialNames: ReadonlyMap<number, string>, credentialLabel: string): string {
  const credential = credentialNames.get(account.credential_id ?? -1) || `${credentialLabel} #${account.credential_id ?? '?'}`;
  return `${account.name || `Account #${account.id}`}｜${credential}`;
}
