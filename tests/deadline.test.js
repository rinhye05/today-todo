const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../deadline-core');
process.env.TZ='Asia/Seoul';
const now=new Date('2026-10-14T19:55:00+09:00');
const task=(id,date,deadline,done=false)=>({id,date,deadline,done,createdAt:1});
test('today deadlines appear before planned tasks independently of plan date, once each',()=>{
  const items=[task('normal','2026-10-14',null),task('future-plan','2026-10-20','2026-10-14T21:00:00+09:00'),task('earlier','2026-10-12','2026-10-14T09:00:00+09:00'),task('both','2026-10-14','2026-10-14T20:00:00+09:00'),task('done','2026-10-14','2026-10-14T20:00:00+09:00',true),task('tomorrow','2026-10-15','2026-10-15T09:00:00+09:00')];
  assert.deepEqual(core.remaining(items,now).map(item=>item.id),['earlier','both','future-plan','normal']);
});
test('upcoming sorts by real deadline, includes past-plan unfinished deadlines, then no-deadline dates',()=>{
  const items=[task('plain-late','2026-10-20'),task('late','2026-10-15','2026-10-18T20:00:00+09:00'),task('early','2026-10-20','2026-10-15T20:00:00+09:00'),task('overdue','2026-10-12','2026-10-13T20:00:00+09:00'),task('plain-early','2026-10-16'),task('done','2026-10-20','2026-10-14T20:00:00+09:00',true)];
  assert.deepEqual(core.upcoming(items,'2026-10-14').map(item=>item.id),['overdue','early','late','plain-early','plain-late']);
});
test('local input round-trips absolute timestamps and detects midnight by local date',()=>{
  const item=task('x','2026-10-20','2026-10-13T15:30:00Z');
  assert.equal(core.inputValue(item),'2026-10-14T00:30');assert.equal(core.dueToday(item,now),true);
  assert.match(core.describe(item,now),/기한 지남/);assert.match(core.describe({...item,done:true},now),/00:30/);assert.doesNotMatch(core.describe({...item,done:true},now),/기한 지남/);
  assert.equal(core.inputValue({deadline:'invalid'}),'');assert.equal(core.dueToday({deadline:null},now),false);
});
