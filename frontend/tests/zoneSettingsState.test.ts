import {describe,it,expect} from 'vitest';
import {ZoneSettingsState} from '../src/utils/zoneSettingsState';
describe('Zone settings drafts',()=>{
 it('preserves dirty values on refresh and detects remote changes',()=>{
  const state=new ZoneSettingsState();const draft=state.accept('1:a',{ssl:'full',cache_level:'aggressive',__meta:{}});draft.form.ssl='strict';
  state.accept('1:a',{ssl:'flexible',cache_level:'basic',__meta:{}});
  expect(draft.form).toEqual({ssl:'strict',cache_level:'basic'});expect(state.dirty(draft)).toEqual(['ssl']);expect(state.conflicts(draft,{ssl:'flexible'})).toEqual(['ssl']);
 });
 it('keeps A→B→A drafts and same-name credentials distinct',()=>{
  const state=new ZoneSettingsState();state.accept('1:a',{ssl:'full',__meta:{}}).form.ssl='strict';state.accept('2:a',{ssl:'off',__meta:{}});
  expect(state.draft('1:a').form.ssl).toBe('strict');expect(state.draft('2:a').form.ssl).toBe('off');
 });
 it('clears only confirmed fields and cancel restores the last actual snapshot',()=>{
  const state=new ZoneSettingsState();const draft=state.accept('1:a',{ssl:'full',http2:'on',__meta:{}});draft.form.ssl='strict';draft.form.http2='off';
  state.confirmed('1:a',{ssl:'strict',http2:'on',__meta:{}},['ssl'],{ssl:'strict',http2:'off'});expect(state.dirty(draft)).toEqual(['http2']);expect(state.cancel('1:a',{ssl:'strict',http2:'on'}).form).toEqual({ssl:'strict',http2:'on'});
 });
 it('limits snapshots and clears every draft at logout',()=>{
  const state=new ZoneSettingsState(2);for(let n=0;n<4;n++)state.accept(`${n}:a`,{ssl:'full',__meta:{}});expect(state.get('0:a')).toBeUndefined();state.clear();expect(state.get('3:a')).toBeUndefined();expect(state.draft('3:a').form).toEqual({});
 });
 it('keeps unsaved drafts when the cache fills and requires saving before editing another Zone',()=>{const state=new ZoneSettingsState(2);state.accept('1:a',{ssl:'full'}).form.ssl='strict';state.accept('2:b',{ssl:'full'}).form.ssl='off';state.accept('3:c',{ssl:'full'});expect(state.canEdit('3:c')).toBe(false);expect(state.draft('1:a').form.ssl).toBe('strict');expect(state.draft('2:b').form.ssl).toBe('off');state.cancel('1:a',{ssl:'full'});expect(state.canEdit('3:c')).toBe(true);});
 it('expires display snapshots without persisting them',()=>{
  const state=new ZoneSettingsState();state.accept('1:a',{ssl:'full',__meta:{}},Date.now()-181000);expect(state.get('1:a')).toBeUndefined();
 });
 it('invalidates one credential or Zone without clearing unrelated metadata',()=>{
  const state=new ZoneSettingsState();state.accept('1:a:identity',{ssl:'full'});state.accept('2:b:identity',{ssl:'strict'});state.invalidate(1);expect(state.get('1:a:identity')).toBeUndefined();expect(state.get('2:b:identity')).toBeDefined();
 });
});
