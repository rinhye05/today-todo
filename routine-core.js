(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TodoSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const parseDate = (value) => { const [y, m, d] = String(value).split('-').map(Number); return new Date(y, m - 1, d); };
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && iso(parseDate(value)) === value;
  // Calendar-day arithmetic stays consistent across daylight-saving changes.
  const dayNumber = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
  const monday = (date) => dayNumber(date) - (date.getDay() + 6) % 7;

  function normalizeRoutine(record) {
    const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value));
    const time = validTime(record.time) ? record.time : '';
    const dayTimes = record.dayTimes ? Object.fromEntries(Object.entries(record.dayTimes).filter(([day, value]) => /^[0-6]$/.test(day) && (value === '' || validTime(value)))) : null;
    return {
      ...record,
      frequency: ['daily', 'weekly', 'monthly'].includes(record.frequency) ? record.frequency : 'weekly',
      interval: Math.max(1, Math.min(365, Math.trunc(Number(record.interval) || 1))),
      weekdays: Array.isArray(record.weekdays) ? [...new Set(record.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))] : [1, 2, 3, 4, 5],
      monthDay: Math.max(1, Math.min(31, Math.trunc(Number(record.monthDay) || parseDate(record.startDate).getDate() || 1))),
      endDate: validDate(record.endDate) ? record.endDate : '',
      occurrences: Array.isArray(record.occurrences) ? record.occurrences : [],
      note: record.note || '',
      priority: record.priority || 'normal',
      placement: record.placement === 'bottom' ? 'bottom' : 'auto',
      time, dayTimes,
      showInPlanner: record.showInPlanner === true && [time, ...Object.values(dayTimes || {})].some(validTime),
    };
  }

  function routineTimeOn(routine, date) {
    return routine.dayTimes?.[parseDate(date).getDay()] ?? routine.time ?? '';
  }

  function isScheduled(routine, value) {
    if (!validDate(value)) return false;
    if (routine.scheduleChangedOn && value < routine.scheduleChangedOn) return (routine.historyDates || []).includes(value);
    if (!validDate(routine.startDate) || value < routine.startDate || (routine.endDate && value > routine.endDate)) return false;
    const date = parseDate(value), start = parseDate(routine.startDate);
    const interval = routine.interval || 1;
    if (routine.frequency === 'daily') return (dayNumber(date) - dayNumber(start)) % interval === 0;
    if (routine.frequency === 'monthly') {
      const months = (date.getFullYear() - start.getFullYear()) * 12 + date.getMonth() - start.getMonth();
      const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      return months % interval === 0 && date.getDate() === Math.min(routine.monthDay || start.getDate(), lastDay);
    }
    return (monday(date) - monday(start)) / 7 % interval === 0 && routine.weekdays.includes(date.getDay());
  }

  function occurrenceTask(tasks, routine, date) {
    return tasks.find((task) => task.routineId === routine.id && (task.routineDate || task.date) === date);
  }

  function occurrenceStatus(routine, date, tasks, today) {
    const task = occurrenceTask(tasks, routine, date);
    if (!task && !isScheduled(routine, date)) return 'off';
    const done = routine.subtask ? Boolean(task?.subtasks?.find((sub) => sub.routineId === routine.id)?.done) : Boolean(task?.done);
    if (done) return 'done';
    if (date < today) return 'missed';
    if (date === today) return 'pending';
    return 'planned';
  }

  function describeRoutine(routine) {
    const count = routine.interval || 1;
    if (routine.frequency === 'daily') return count === 1 ? '매일' : `${count}일마다`;
    if (routine.frequency === 'monthly') return `${count === 1 ? '매월' : `${count}개월마다`} ${routine.monthDay}일`;
    const names = ['일', '월', '화', '수', '목', '금', '토'];
    const days = [1, 2, 3, 4, 5, 6, 0].filter((day) => routine.weekdays.includes(day)).map((day) => names[day]).join('·');
    return `${count === 1 ? '매주' : `${count}주마다`} ${days}`;
  }

  function reminderKey(settings, now, lastKey) {
    if (!settings.enabled || !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.time)) return null;
    const [hours, minutes] = settings.time.split(':').map(Number);
    if (now.getHours() * 60 + now.getMinutes() < hours * 60 + minutes) return null;
    const key = `${iso(now)}@${settings.time}`;
    return key === lastKey ? null : key;
  }

  return { iso, parseDate, validDate, normalizeRoutine, routineTimeOn, isScheduled, occurrenceTask, occurrenceStatus, describeRoutine, reminderKey };
});
