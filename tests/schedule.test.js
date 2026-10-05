const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRoutine, routineTimeOn, isScheduled, occurrenceStatus, reminderKey } = require('../routine-core');
const routine = (values = {}) => normalizeRoutine({ id: 'walk', startDate: '2026-10-05', weekdays: [1, 3, 5], ...values });

test('weekly intervals use calendar weeks and include both period boundaries', () => {
  const plan = routine({ startDate: '2026-10-07', interval: 2, endDate: '2026-10-23' });
  assert.equal(isScheduled(plan, '2026-10-05'), false);
  assert.equal(isScheduled(plan, '2026-10-07'), true);
  assert.equal(isScheduled(plan, '2026-10-09'), true);
  assert.equal(isScheduled(plan, '2026-10-14'), false);
  assert.equal(isScheduled(plan, '2026-10-19'), true);
  assert.equal(isScheduled(plan, '2026-10-23'), true);
  assert.equal(isScheduled(plan, '2026-11-02'), false);
});

test('daily intervals follow calendar days across month boundaries and DST', () => {
  const oldTimezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const plan = routine({ frequency: 'daily', interval: 2, startDate: '2026-10-31' });
    assert.equal(isScheduled(plan, '2026-10-31'), true);
    assert.equal(isScheduled(plan, '2026-11-01'), false);
    assert.equal(isScheduled(plan, '2026-11-02'), true);
    assert.equal(isScheduled(plan, '2026-11-04'), true);
  } finally { if (oldTimezone === undefined) delete process.env.TZ; else process.env.TZ = oldTimezone; }
});

test('monthly dates clamp to the last day, including leap years', () => {
  const plan = routine({ frequency: 'monthly', monthDay: 31, startDate: '2028-01-31' });
  assert.equal(isScheduled(plan, '2028-02-28'), false);
  assert.equal(isScheduled(plan, '2028-02-29'), true);
  assert.equal(isScheduled(plan, '2028-04-30'), true);
  assert.equal(isScheduled(plan, '2028-05-31'), true);
  const alternate = routine({ frequency: 'monthly', interval: 2, monthDay: 31, startDate: '2026-12-31' });
  assert.equal(isScheduled(alternate, '2027-01-31'), false);
  assert.equal(isScheduled(alternate, '2027-02-28'), true);
});

test('legacy weekly routines remain readable; invalid calendar dates are rejected', () => {
  const plan = routine();
  assert.equal(plan.frequency, 'weekly');
  assert.equal(plan.interval, 1);
  assert.equal(isScheduled(plan, '2026-10-05'), true);
  assert.equal(isScheduled(plan, '2026-02-31'), false);
  assert.equal(isScheduled(plan, ''), false);
});

test('history distinguishes missed, today, future, completed, and off days', () => {
  const plan = routine();
  const tasks = [{ routineId: 'walk', routineDate: '2026-10-05', date: '2026-10-07', done: true }];
  assert.equal(occurrenceStatus(plan, '2026-10-05', tasks, '2026-10-07'), 'done');
  assert.equal(occurrenceStatus(plan, '2026-10-05', [], '2026-10-07'), 'missed');
  assert.equal(occurrenceStatus(plan, '2026-10-07', [], '2026-10-07'), 'pending');
  assert.equal(occurrenceStatus(plan, '2026-10-09', [], '2026-10-07'), 'planned');
  assert.equal(occurrenceStatus(plan, '2026-10-08', [], '2026-10-07'), 'off');
});

test('subtask routines follow the subtask completion rather than parent status', () => {
  const plan = routine({ subtask: true });
  const tasks = [{ routineId: 'walk', date: '2026-10-05', done: false, subtasks: [{ routineId: 'walk', done: true }, { done: false }] }];
  assert.equal(occurrenceStatus(plan, '2026-10-05', tasks, '2026-10-07'), 'done');
});

test('editing a schedule preserves previous dates without adding new historical misses', () => {
  const plan = routine({ frequency: 'daily', startDate: '2026-10-01', scheduleChangedOn: '2026-10-07', historyDates: ['2026-10-05'] });
  assert.equal(isScheduled(plan, '2026-10-05'), true);
  assert.equal(isScheduled(plan, '2026-10-06'), false);
  assert.equal(isScheduled(plan, '2026-10-07'), true);
});

test('reminders fire once per day and time, including missed times after reopening', () => {
  const settings = { enabled: true, time: '20:00' };
  assert.equal(reminderKey(settings, new Date(2026, 9, 4, 19, 59)), null);
  assert.equal(reminderKey(settings, new Date(2026, 9, 4, 20, 0)), '2026-10-04@20:00');
  assert.equal(reminderKey(settings, new Date(2026, 9, 4, 23, 30), '2026-10-04@20:00'), null);
  assert.equal(reminderKey(settings, new Date(2026, 9, 5, 23, 30), '2026-10-04@20:00'), '2026-10-05@20:00');
  assert.equal(reminderKey({ ...settings, enabled: false }, new Date(2026, 9, 5, 23, 30)), null);
  assert.equal(reminderKey({ ...settings, time: '25:00' }, new Date()), null);
});

test('routine times are optional, may differ by weekday, and empty overrides stay untimed', () => {
  const old=normalizeRoutine({id:'old',startDate:'2026-10-01'});
  assert.equal(old.time,'');assert.equal(old.showInPlanner,false);
  const custom=normalizeRoutine({id:'timed',startDate:'2026-10-01',time:'20:00',dayTimes:{1:'09:00',3:'',5:'22:15',9:'12:00'},showInPlanner:true});
  assert.equal(routineTimeOn(custom,'2026-10-12'),'09:00');assert.equal(routineTimeOn(custom,'2026-10-14'),'');assert.equal(routineTimeOn(custom,'2026-10-16'),'22:15');assert.equal(custom.showInPlanner,true);assert.equal(custom.dayTimes[9],undefined);
  assert.equal(normalizeRoutine({time:'25:00',showInPlanner:true}).showInPlanner,false);
});
