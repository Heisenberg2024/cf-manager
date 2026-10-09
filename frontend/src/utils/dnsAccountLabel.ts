export interface DnsAccountIdentity {
  id: number;
  name?: string;
  account_id?: string | null;
  credential_id?: number;
  credential_name?: string;
}

/** Include both identities even when credentials and Account names are duplicated. */
export function dnsAccountLabel(account: DnsAccountIdentity, credentialLabel: string): string {
  const credential = `${account.credential_name || credentialLabel} #${account.credential_id ?? '?'}`;
  return `${credential} / ${account.name || `Account #${account.id}`} · ${account.account_id || `#${account.id}`}`;
}
