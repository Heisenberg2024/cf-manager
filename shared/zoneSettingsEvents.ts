export interface ZoneSaveProgress {type:'progress';key:string;stage:'checking'|'saving'|'confirming'|'done';status?:string;actual?:unknown;reason?:string;completed:number;total:number;patchCount:number}

export type FieldStatus = 'updated' | 'unchanged' | 'unavailable' | 'failed' | 'uncertain' | 'conflict';
export interface ZoneSettingsSnapshot extends Record<string, unknown> {
  __meta: Record<string, { editable: boolean; state?: 'available' | 'readonly' | 'unavailable' | 'error'; reason?: string; modifiedOn?: string }>;
}
export interface ZoneSettingsResult {
  updated: string[];
  failed: string[];
  errors: Record<string, string>;
  fields: Record<string, { status: FieldStatus; reason?: string; actual?: unknown }>;
  settings: ZoneSettingsSnapshot;
  patchCount: number;
  conflictDetection: 'non-atomic';
}
