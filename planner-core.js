(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./routine-core') : root.TodoSchedule);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TodoPlannerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, (schedule) => {
  const { iso, parseDate, validDate } = schedule;
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const dayNumber = (value) => { const d = parseDate(value); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000; };
  const addDays = (value, amount) => { const d = parseDate(value); d.setDate(d.getDate() + amount); return iso(d); };
  const weekStart = (value) => addDays(value, -parseDate(value).getDay());
  const weekDates = (value) => Array.from({ length: 7 }, (_, day) => addDays(weekStart(value), day));
  const minutes = (value) => value === '24:00' ? 1440 : /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
  const time = (value) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  const safeColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value)) ? value : '#7bb8ff';
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;

  function planAt(plan, date) {
    if (plan.deletedFrom && date >= plan.deletedFrom) return null;
    const version = (plan.versions || []).find((item) => date >= item.startDate && date <= item.until);
    const result = version ? { ...version, id: plan.id } : plan;
    if (!validDate(result.startDate) || date < result.startDate || (result.endDate && date > result.endDate) || !result.weekdays?.includes(parseDate(date).getDay())) return null;
    return { ...result, ...(result.dayTimes?.[parseDate(date).getDay()] || {}) };
  }

  function planInstances(records, date) {
    const checks = records.filter((record) => record.type === 'plan-check' && record.date === date);
    return records.filter((record) => record.type === 'plan').flatMap((plan) => {
      const check = checks.find((item) => item.planId === plan.id);
      const current = planAt(plan, date);
      const snapshot = check?.done && check.snapshot ? check.snapshot : current;
      if (!snapshot || !Number.isFinite(minutes(snapshot.startTime)) || !Number.isFinite(minutes(snapshot.endTime)) || minutes(snapshot.endTime) <= minutes(snapshot.startTime)) return [];
      return [{ ...snapshot, id: plan.id, date, done: Boolean(check?.done), checkId: check?.id, start: minutes(snapshot.startTime), end: minutes(snapshot.endTime) }];
    }).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  }

  function startsBetween(event, from, through) {
    if (!validDate(event.startDate)) return [];
    const initial = event.startDate;
    if (!event.repeat || event.repeat === 'none') return initial >= from && initial <= through ? [initial] : [];
    const begin = from > initial ? from : initial;
    const end = event.repeatUntil && event.repeatUntil < through ? event.repeatUntil : through;
    if (begin > end) return [];
    const interval = Math.max(1, Math.min(365, Math.trunc(Number(event.interval) || 1)));
    const values = [];
    if (event.repeat === 'daily') {
      const offset = Math.max(0, Math.ceil((dayNumber(begin) - dayNumber(initial)) / interval) * interval);
      for (let date = addDays(initial, offset); date <= end; date = addDays(date, interval)) values.push(date);
    } else if (event.repeat === 'weekly') {
      const firstWeek = weekStart(initial);
      const offset = Math.max(0, Math.floor((dayNumber(weekStart(begin)) - dayNumber(firstWeek)) / (7 * interval)) * 7 * interval);
      for (let week = addDays(firstWeek, offset); week <= end; week = addDays(week, 7 * interval)) {
        for (const day of (event.weekdays || [parseDate(initial).getDay()]).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)) {
          const date = addDays(week, day);
          if (date >= begin && date <= end) values.push(date);
        }
      }
    } else if (event.repeat === 'monthly') {
      const start = parseDate(initial), first = parseDate(begin), last = parseDate(end);
      const firstMonth = (first.getFullYear() - start.getFullYear()) * 12 + first.getMonth() - start.getMonth();
      const lastMonth = (last.getFullYear() - start.getFullYear()) * 12 + last.getMonth() - start.getMonth();
      for (let month = Math.max(0, Math.floor(firstMonth / interval) * interval); month <= lastMonth; month += interval) {
        const base = new Date(start.getFullYear(), start.getMonth() + month, 1);
        const day = Math.min(start.getDate(), new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate());
        const date = iso(new Date(base.getFullYear(), base.getMonth(), day));
        if (date >= begin && date <= end) values.push(date);
      }
    }
    return [...new Set(values)].sort();
  }

  function eventInstances(events, from, through) {
    const instances = [];
    const rangeStart = dayNumber(from) * 1440, rangeEnd = (dayNumber(through) + 1) * 1440;
    for (const event of events.filter((item) => !item.deleted && item.active !== false)) {
      const duration = dayNumber(event.endDate || event.startDate) - dayNumber(event.startDate);
      const startMinute = event.allDay ? 0 : minutes(event.startTime);
      const endMinute = event.allDay ? 1440 : minutes(event.endTime);
      if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(startMinute) || !Number.isFinite(endMinute)) continue;
      for (const date of startsBetween(event, addDays(from, -duration), through)) {
        const start = dayNumber(date) * 1440 + startMinute, end = (dayNumber(date) + duration) * 1440 + endMinute;
        if (end <= start || !overlaps({ start, end }, { start: rangeStart, end: rangeEnd })) continue;
        instances.push({ ...event, occurrenceDate: date, instanceId: `${event.id}@${date}`, start, end });
      }
    }
    return instances.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  }

  function eventsOnDate(instances, date) {
    const base = dayNumber(date) * 1440;
    return instances.filter((event) => overlaps(event, { start: base, end: base + 1440 })).map((event) => ({ ...event, date, start: Math.max(0, event.start - base), end: Math.min(1440, event.end - base) }));
  }

  function routinePoints(routines, tasks, date) {
    return tasks.filter((task) => task.date === date).flatMap((task) => {
      const routine = routines.find((item) => item.id === task.routineId);
      if (!routine?.showInPlanner || task.placement === 'bottom') return [];
      const value = task.routineTime ?? schedule.routineTimeOn(routine, task.routineDate || date);
      const start = minutes(value);
      if (!Number.isFinite(start) || start >= 1440) return [];
      const sub = routine.subtask ? task.subtasks?.find((item) => item.routineId === routine.id) : null;
      return [{ id: `point-${task.id}`, routineId: routine.id, taskId: task.id, occurrenceDate: task.routineDate || date, title: sub?.title || task.title, categoryId: task.categoryId || routine.categoryId || '', time: value, start, end: Math.min(1440, start + 15), done: routine.subtask ? Boolean(sub?.done) : Boolean(task.done) }];
    });
  }

  function sortCompletedLast(items, enabled = true) {
    return enabled
      ? [...items.filter((item) => !item.done), ...items.filter((item) => item.done)]
      : [...items];
  }

  function sortDailyItems(items, date) {
    const kind = (item) => item.type === 'plan' ? 2 : item.routineId ? 1 : 0;
    const when = (item) => {
      const deadline = item.deadline && Date.parse(item.deadline);
      if (Number.isFinite(deadline)) return deadline;
      const value = item.type === 'plan' ? item.startTime : item.routineTime;
      if (!Number.isFinite(minutes(value))) return Infinity;
      const base = parseDate(item.date || date).getTime();
      return base + minutes(value) * 60000;
    };
    return [...items].sort((a, b) => kind(a) - kind(b) || (a.order ?? 0) - (b.order ?? 0) || when(a) - when(b) || (a.createdAt || 0) - (b.createdAt || 0));
  }

  function dayModel(records, tasks, date, instances = null, routines = []) {
    const events = eventsOnDate(instances || eventInstances(records.filter((item) => item.type === 'event'), date, date), date);
    const plans = planInstances(records, date).map((plan) => {
      const conflicts = events.filter((event) => overlaps(plan, event));
      const move = !plan.done && conflicts.find((event) => event.planMoves?.[plan.id]);
      if (move) {
        const value = move.planMoves[plan.id];
        const start = minutes(value.startTime), end = minutes(value.endTime);
        const candidate = { start, end };
        const occupied = planInstances(records, date).filter((item) => item.id !== plan.id);
        for (const event of events) {
          for (const [id, other] of Object.entries(event.planMoves || {})) {
            if (id !== plan.id && occupied.some((item) => item.id === id)) occupied.push({ start: minutes(other.startTime), end: minutes(other.endTime) });
          }
        }
        if (Number.isFinite(start) && end > start && !events.some((event) => overlaps(candidate, event)) && !occupied.some((item) => overlaps(candidate, item))) {
          return { ...plan, originalStartTime: plan.startTime, originalEndTime: plan.endTime, startTime: value.startTime, endTime: value.endTime, start, end, movedByEvent: move.id, conflicts: [], blocked: false, tasks: [] };
        }
      }
      return { ...plan, conflicts, blocked: !plan.done && conflicts.some((event) => !event.allowPlan), tasks: [] };
    });
    const unplaced = [];
    const points = routinePoints(routines, tasks, date);
    const standalonePoints = [];
    for (const task of tasks.filter((item) => item.date === date)) {
      if (task.placement === 'bottom') { unplaced.push(task); continue; }
      const scheduledTime = minutes(task.routineTime);
      const target = task.categoryId && plans.find((plan) => !plan.blocked && plan.categoryId === task.categoryId && (!task.planId || plan.id === task.planId) && (!Number.isFinite(scheduledTime) || (plan.start <= scheduledTime && scheduledTime < plan.end)));
      const point = points.find((item) => item.taskId === task.id);
      if (target) target.tasks.push(task);
      else if (point) standalonePoints.push(point);
      else unplaced.push(task);
    }
    return { date, plans, events, unplaced: sortDailyItems(unplaced, date), routinePoints: standalonePoints };
  }

  function weekModel(records, tasks, date, routines = []) {
    const dates = weekDates(date);
    const instances = eventInstances(records.filter((item) => item.type === 'event'), dates[0], dates[6]);
    return dates.map((value) => dayModel(records, tasks, value, instances, routines));
  }

  function layout(items) {
    // Each overlap group uses a common lane count; touching boundaries do not overlap.
    const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
    const output = [];
    let group = [], groupEnd = -1;
    const flush = () => {
      const ends = [];
      const arranged = group.map((item) => {
        let lane = ends.findIndex((end) => end <= item.start);
        if (lane < 0) lane = ends.length;
        ends[lane] = item.end;
        return { ...item, lane };
      });
      output.push(...arranged.map((item) => ({ ...item, lanes: ends.length })));
    };
    for (const item of sorted) {
      if (group.length && item.start >= groupEnd) { flush(); group = []; groupEnd = -1; }
      group.push(item); groupEnd = Math.max(groupEnd, item.end);
    }
    if (group.length) flush();
    return output;
  }

  function weekLabel(date) {
    const start = parseDate(weekStart(date));
    const first = new Date(start.getFullYear(), start.getMonth(), 1);
    const week = Math.floor((start.getDate() + first.getDay() - 1) / 7) + 1;
    return `${start.getFullYear()}년 ${start.getMonth() + 1}월 ${week}주차`;
  }

  return { days, addDays, weekStart, weekDates, weekLabel, minutes, time, safeColor, overlaps, planAt, planInstances, routinePoints, sortCompletedLast, sortDailyItems, startsBetween, eventInstances, eventsOnDate, dayModel, weekModel, layout };
});
