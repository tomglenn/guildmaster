import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence, previousOccurrence, recurrenceSummary } from '../src/domain/recurrence.ts';
const all=[0,1,2,3,4,5,6];
const iso=(n:number)=>new Date(n).toISOString();
test('recurrences respect weekdays, exact instants, and named timezones',()=>{
 const rule={days:[1,2,3,4,5],time:'08:30',timezone:'Europe/London'};
 assert.equal(iso(nextOccurrence(rule,Date.parse('2026-10-16T07:29Z'))),'2026-10-16T07:30:00.000Z');
 assert.equal(iso(nextOccurrence(rule,Date.parse('2026-10-16T07:30Z'))),'2026-10-19T07:30:00.000Z');
 assert.equal(iso(previousOccurrence(rule,Date.parse('2026-10-19T06:30Z'))),'2026-10-16T07:30:00.000Z');
 assert.match(recurrenceSummary(rule),/Weekdays/);
});
test('DST spring gaps use the first valid minute; repeated hours run once',()=>{
 const rule={days:all,time:'01:30',timezone:'Europe/London'};
 assert.equal(iso(nextOccurrence(rule,Date.parse('2026-03-29T00:00Z'))),'2026-03-29T01:00:00.000Z');
 assert.equal(iso(nextOccurrence(rule,Date.parse('2026-10-25T00:00Z'))),'2026-10-25T00:30:00.000Z');
 assert.equal(iso(nextOccurrence(rule,Date.parse('2026-10-25T00:45Z'))),'2026-10-26T01:30:00.000Z');
 assert.equal(iso(previousOccurrence(rule,Date.parse('2026-10-25T01:45Z'))),'2026-10-25T00:30:00.000Z');
});
test('non-hour offsets and half-hour DST transitions resolve correctly',()=>{
 assert.equal(iso(nextOccurrence({days:all,time:'08:30',timezone:'Asia/Kathmandu'},Date.parse('2026-10-16T00:00Z'))),'2026-10-16T02:45:00.000Z');
 assert.equal(iso(nextOccurrence({days:all,time:'02:15',timezone:'Australia/Lord_Howe'},Date.parse('2026-10-03T12:00Z'))),'2026-10-03T15:30:00.000Z');
});
test('invalid times, empty weekdays and unknown timezones fail before scheduling',()=>{
 for(const patch of [{days:[]},{days:[1,1]},{time:'25:00'},{timezone:'Not/AZone'}])assert.throws(()=>nextOccurrence({days:all,time:'08:30',timezone:'UTC',...patch},Date.now()));
});
