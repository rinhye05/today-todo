const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../planner-core');
const plan = (values = {}) => ({ type: 'plan', id: 'exercise', title: '운동', categoryId: 'fitness', startDate: '2026-10-01', weekdays: [1], startTime: '20:00', endTime: '21:00', ...values });
const event = (values = {}) => ({ type: 'event', id: 'dinner', title: '약속', startDate: '2026-10-12', endDate: '2026-10-12', startTime: '20:30', endTime: '21:30', repeat: 'none', allowPlan: false, ...values });

test('weeks start Sunday and cross month/year boundaries', () => {
  assert.deepEqual(core.weekDates('2027-01-01'), ['2026-12-27','2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02']);
  assert.equal(core.weekLabel('2026-10-14'), '2026년 10월 3주차');
});
test('repeat intervals, weekdays and inclusive end date are respected', () => {
  assert.deepEqual(core.startsBetween(event({ repeat:'weekly', interval:2, weekdays:[1,3], repeatUntil:'2026-10-28' }), '2026-10-01','2026-11-30'), ['2026-10-12','2026-10-14','2026-10-26','2026-10-28']);
  assert.deepEqual(core.startsBetween(event({ repeat:'daily', interval:3, repeatUntil:'2026-10-18' }), '2026-10-13','2026-11-01'), ['2026-10-15','2026-10-18']);
});
test('monthly recurrence preserves the original day and clamps leap month ends', () => {
  assert.deepEqual(core.startsBetween(event({ startDate:'2028-01-31', repeat:'monthly', interval:1 }), '2028-02-01','2028-05-31'), ['2028-02-29','2028-03-31','2028-04-30','2028-05-31']);
});
test('overnight events are clipped by day and midnight end does not leak', () => {
  const instances = core.eventInstances([event({ endDate:'2026-10-13', startTime:'23:00', endTime:'00:00' })], '2026-10-12','2026-10-13');
  assert.deepEqual(core.eventsOnDate(instances,'2026-10-12').map(({start,end})=>[start,end]), [[1380,1440]]);
  assert.equal(core.eventsOnDate(instances,'2026-10-13').length,0);
  const overnight = core.eventInstances([event({ endDate:'2026-10-13', startTime:'23:00', endTime:'02:00', repeat:'weekly', weekdays:[1], interval:1 })], '2026-10-20','2026-10-20');
  assert.equal(overnight[0].occurrenceDate,'2026-10-19');
  assert.deepEqual(core.eventsOnDate(overnight,'2026-10-20').map(({start,end})=>[start,end]), [[0,120]]);
});
test('all-day multi-day events include both dates', () => {
  const instances=core.eventInstances([event({allDay:true,endDate:'2026-10-14'})],'2026-10-12','2026-10-15');
  assert.deepEqual(['2026-10-12','2026-10-13','2026-10-14','2026-10-15'].map(date=>core.eventsOnDate(instances,date).length),[1,1,1,0]);
});
test('category tasks are placed exactly once in the first eligible matching plan', () => {
  const tasks=[{id:'run',date:'2026-10-12',categoryId:'fitness'},{id:'plain',date:'2026-10-12'},{id:'other',date:'2026-10-13',categoryId:'fitness'}];
  const records=[plan(),plan({id:'later',startTime:'22:00',endTime:'23:00'}),event()];
  let day=core.dayModel(records,tasks,'2026-10-12');
  assert.equal(day.plans[0].blocked,true); assert.equal(day.plans[1].tasks[0].id,'run'); assert.equal(day.unplaced[0].id,'plain');
  records[2].allowPlan=true; day=core.dayModel(records,tasks,'2026-10-12');
  assert.equal(day.plans[0].blocked,false); assert.equal(day.plans[0].tasks[0].id,'run'); assert.equal(day.plans[1].tasks.length,0);
});
test('touching boundaries do not block plans; completed plans stay in achievement totals', () => {
  assert.equal(core.dayModel([plan(),event({startTime:'21:00'})],[],'2026-10-12').plans[0].blocked,false);
  const check={type:'plan-check',planId:'exercise',date:'2026-10-12',done:true,snapshot:plan()};
  assert.equal(core.dayModel([plan(),event(),check],[],'2026-10-12').plans[0].blocked,false);
});
test('plan versions and completion snapshots preserve earlier schedules after edit/delete', () => {
  const old=plan(), current=plan({startDate:'2026-10-14',weekdays:[3],startTime:'18:00',endTime:'19:00',versions:[{...old,until:'2026-10-13'}]});
  assert.equal(core.planInstances([current],'2026-10-12')[0].start,1200);
  assert.equal(core.planInstances([current],'2026-10-14')[0].start,1080);
  current.deletedFrom='2026-10-14'; assert.equal(core.planInstances([current],'2026-10-14').length,0);
  const check={type:'plan-check',planId:current.id,date:'2026-10-14',done:true,snapshot:{...old,weekdays:[3]}};
  assert.equal(core.planInstances([current,check],'2026-10-14')[0].start,1200);
});
test('layout assigns overlapping blocks separate lanes and reuses lanes at boundaries', () => {
  const items=core.layout([{id:'a',start:60,end:120},{id:'b',start:90,end:150},{id:'c',start:120,end:150},{id:'d',start:150,end:180}]);
  assert.deepEqual(items.map(item=>[item.id,item.lane,item.lanes]),[['a',0,2],['b',1,2],['c',0,2],['d',0,1]]);
});

test('per-weekday plan times drive placement and event conflicts', () => {
  const custom = plan({ weekdays:[1,3], dayTimes:{1:{startTime:'20:00',endTime:'21:00'},3:{startTime:'09:00',endTime:'10:00'}} });
  assert.equal(core.planInstances([custom],'2026-10-12')[0].start,1200);
  assert.equal(core.planInstances([custom],'2026-10-14')[0].start,540);
  const day=core.dayModel([custom,event({startDate:'2026-10-14',endDate:'2026-10-14',startTime:'09:30',endTime:'10:00'})],[],'2026-10-14');
  assert.equal(day.plans[0].blocked,true);
});

test('bottom placement overrides category matching and routine point display', () => {
  const routine={id:'run',showInPlanner:true,time:'20:15'};
  const tasks=[{id:'plain',date:'2026-10-12',categoryId:'fitness',placement:'bottom'}, {id:'timed',date:'2026-10-12',routineId:'run',routineTime:'20:15',categoryId:'fitness',placement:'bottom'}];
  const day=core.dayModel([plan()],tasks,'2026-10-12',null,[routine]);
  assert.equal(day.plans[0].tasks.length,0);assert.equal(day.routinePoints.length,0);assert.equal(day.unplaced.length,2);
});

test('timed routines appear exactly once, inside a matching time/category or as standalone points', () => {
  const routines=[{id:'run',showInPlanner:true,time:'20:15'},{id:'early',showInPlanner:true,time:'09:00'}];
  const tasks=[{id:'inside',date:'2026-10-12',routineId:'run',routineTime:'20:15',categoryId:'fitness'},{id:'outside',date:'2026-10-12',routineId:'early',routineTime:'09:00',categoryId:'fitness'}];
  const day=core.dayModel([plan()],tasks,'2026-10-12',null,routines);
  assert.deepEqual(day.plans[0].tasks.map(item=>item.id),['inside']);assert.deepEqual(day.routinePoints.map(item=>item.taskId),['outside']);assert.equal(day.unplaced.length,0);
  routines[1].showInPlanner=false;
  assert.deepEqual(core.dayModel([plan()],tasks,'2026-10-12',null,routines).unplaced.map(item=>item.id),['outside']);
});

test('routine points retain stored occurrence times and subtask completion', () => {
  const routine={id:'run',showInPlanner:true,time:'15:00',subtask:true};
  const task={id:'old',routineId:'run',date:'2026-10-12',routineDate:'2026-10-11',routineTime:'23:59',done:false,subtasks:[{routineId:'run',title:'산책',done:true}]};
  const [point]=core.routinePoints([routine],[task],'2026-10-12');
  assert.equal(point.time,'23:59');assert.equal(point.done,true);assert.equal(point.title,'산책');assert.equal(point.occurrenceDate,'2026-10-11');
});

test('explicit task plan choice overrides automatic placement and survives unavailable targets without moving to another plan', () => {
  const records=[plan(),plan({id:'later',startTime:'21:00',endTime:'22:00'})];
  const task={id:'task',date:'2026-10-12',categoryId:'fitness',planId:'later'};
  let day=core.dayModel(records,[task],'2026-10-12');
  assert.equal(day.plans[0].tasks.length,0);assert.deepEqual(day.plans[1].tasks.map(item=>item.id),['task']);
  for(const modified of [{deletedFrom:'2026-10-12'},{categoryId:'other'},{weekdays:[2]}]) {
    day=core.dayModel([records[0],{...records[1],...modified}],[task],'2026-10-12');
    assert.deepEqual(day.unplaced.map(item=>item.id),['task']);assert.ok(day.plans.every(item=>item.tasks.length===0));
  }
  day=core.dayModel([...records,event({startTime:'21:00',endTime:'22:00'})],[task],'2026-10-12');
  assert.deepEqual(day.unplaced.map(item=>item.id),['task']);
  assert.deepEqual(core.dayModel(records,[{...task,placement:'bottom'}],'2026-10-12').unplaced.map(item=>item.id),['task']);
  assert.equal(core.dayModel(records,[{...task,planId:null}],'2026-10-12').plans[0].tasks.length,1);
});

test('daily and weekly lists sort by kind, deadline or time with unscheduled items last', () => {
  const date='2026-10-12';
  const items=[{id:'none',date,placement:'bottom'},{id:'late',date,deadline:'2026-10-12T18:00:00+09:00'},{id:'early',date,deadline:'2026-10-12T08:00:00+09:00',done:true,placement:'bottom'},{id:'routine-none',date,routineId:'r0'},{id:'routine-late',date,routineId:'r1',routineTime:'18:00'},{id:'routine-early',date,routineId:'r2',routineTime:'08:00'},{id:'plan-late',type:'plan',startTime:'19:00'},{id:'plan-early',type:'plan',startTime:'07:00'}];
  assert.deepEqual(core.sortDailyItems(items,date).map(item=>item.id),['early','late','none','routine-early','routine-late','routine-none','plan-early','plan-late']);
  assert.deepEqual(core.dayModel([],items.filter(item=>item.type!=='plan'),date).unplaced.map(item=>item.id),['early','late','none','routine-early','routine-late','routine-none']);
});

test('event moves an unfinished plan and cancellation restores its original time and tasks', () => {
  const appointment = event({ planMoves: { exercise: { startTime: '22:00', endTime: '23:00' } } });
  const task = { id: 'todo', date: '2026-10-12', categoryId: 'fitness', planId: 'exercise' };
  let model = core.dayModel([plan(), appointment], [task], '2026-10-12');
  assert.equal(model.plans[0].startTime, '22:00');
  assert.equal(model.plans[0].blocked, false);
  assert.equal(model.plans[0].tasks[0].id, 'todo');
  model = core.dayModel([plan(), { ...appointment, active: false }], [task], '2026-10-12');
  assert.equal(model.events.length, 0);
  assert.equal(model.plans[0].startTime, '20:00');
  assert.equal(model.plans[0].tasks[0].id, 'todo');
});
test('invalid or occupied relocation keeps conflict policy, completed plans preserve history', () => {
  const appointment = event({ planMoves: { exercise: { startTime: '20:00', endTime: '21:00' } } });
  assert.equal(core.dayModel([plan(), appointment], [], '2026-10-12').plans[0].blocked, true);
  const occupied = plan({ id: 'other', startTime: '22:00', endTime: '23:00' });
  appointment.planMoves.exercise = { startTime: '22:00', endTime: '23:00' };
  assert.equal(core.dayModel([plan(), occupied, appointment], [], '2026-10-12').plans.find(p => p.id === 'exercise').blocked, true);
  const check = { type: 'plan-check', planId: 'exercise', date: '2026-10-12', done: true, snapshot: plan() };
  assert.equal(core.dayModel([plan(), appointment, check], [], '2026-10-12').plans[0].startTime, '20:00');
});
