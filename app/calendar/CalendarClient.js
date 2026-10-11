'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import TaskDrawer from '@/components/kanban/TaskDrawer';
import MeetingDrawer from '@/components/meetings/MeetingDrawer';
import CalendarToolbar from '@/components/calendar/CalendarToolbar';
import MonthGrid from '@/components/calendar/MonthGrid';
import TimeGrid from '@/components/calendar/TimeGrid';
import AgendaPanel from '@/components/calendar/AgendaPanel';
import UnscheduledTray from '@/components/calendar/UnscheduledTray';
import ExternalEventDrawer from '@/components/calendar/ExternalEventDrawer';
import MobileDayList from '@/components/calendar/MobileDayList';
import { cn } from '@/lib/utils';
import {
  toDateStr,
  parseLocalDate,
  addDays,
  startOfWeek,
  visibleRangeForView,
} from '@/lib/dates';

function titleForView(view, currentDate) {
  if (view === 'day') {
    return currentDate.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }
  if (view === 'week') {
    const start = startOfWeek(currentDate);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    if (sameMonth) {
      return `${start.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })} – ${end.getDate()}, ${end.getFullYear()}`;
    }
    return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  return currentDate.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

export default function CalendarClient({
  initialTasks,
  initialMeetings,
  initialExternalEvents = [],
  initialSyncStatus = null,
  initialRange = null,
  initialDateKey = null,
}) {
  const [tasks, setTasks] = useState(initialTasks);
  const [meetings] = useState(initialMeetings);
  const [externalEvents, setExternalEvents] = useState(initialExternalEvents);
  const [syncStatus, setSyncStatus] = useState(initialSyncStatus);
  const [currentDate, setCurrentDate] = useState(() => {
    const parsed = initialDateKey ? parseLocalDate(initialDateKey) : null;
    return parsed || new Date();
  });
  const [view, setView] = useState('month');
  const [selectedDay, setSelectedDay] = useState(() => {
    const parsed = initialDateKey ? parseLocalDate(initialDateKey) : null;
    return parsed || new Date();
  });
  const [drawerTask, setDrawerTask] = useState(null);
  const [drawerMeeting, setDrawerMeeting] = useState(null);
  const [drawerExternal, setDrawerExternal] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [search, setSearch] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [sortBy, setSortBy] = useState('priority');
  const [showCompleted, setShowCompleted] = useState(false);
  const [showExternal, setShowExternal] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadedRange, setLoadedRange] = useState(initialRange);
  const [caldavSources, setCaldavSources] = useState([]);
  const [hiddenSourceIds, setHiddenSourceIds] = useState(new Set());

  const clearFilters = useCallback(() => {
    setSearch('');
    setPriorityFilter('all');
    setProjectFilter('all');
    setSortBy('priority');
  }, []);

  useEffect(() => {
    if (!window.matchMedia('(min-width: 1024px)').matches) {
      setDetailsOpen(false);
    }
  }, []);

  const range = useMemo(
    () => visibleRangeForView(view, currentDate),
    [view, currentDate],
  );

  const fetchExternalEvents = useCallback(async (from, to) => {
    setLoadingEvents(true);
    try {
      const res = await fetch(
        `/api/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error('Failed to load events');
      const data = await res.json();
      setExternalEvents(Array.isArray(data.events) ? data.events : []);
      setLoadedRange({ from, to });
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingEvents(false);
    }
  }, []);

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch('/api/calendar/sources', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load calendar sources');
      const data = await res.json();
      setCaldavSources(Array.isArray(data.sources) ? data.sources : []);
    } catch (error) {
      console.error(error);
    }
  }, []);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('calendar-hidden-caldav-sources');
      if (saved) {
        setHiddenSourceIds(new Set(JSON.parse(saved)));
      }
    } catch {
      // ignore localStorage errors
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        'calendar-hidden-caldav-sources',
        JSON.stringify([...hiddenSourceIds]),
      );
    } catch {
      // ignore localStorage errors
    }
  }, [hiddenSourceIds]);

  const visibleExternalEvents = useMemo(
    () =>
      showExternal
        ? externalEvents.filter((event) => !hiddenSourceIds.has(event.sourceId))
        : [],
    [showExternal, externalEvents, hiddenSourceIds],
  );

  useEffect(() => {
    if (
      loadedRange &&
      loadedRange.from === range.from &&
      loadedRange.to === range.to
    ) {
      return;
    }
    fetchExternalEvents(range.from, range.to);
  }, [range.from, range.to, loadedRange, fetchExternalEvents]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/calendar/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json().catch(() => ({}));
      setSyncStatus(data);
      await fetchExternalEvents(range.from, range.to);
    } catch (error) {
      console.error(error);
    } finally {
      setRefreshing(false);
    }
  }, [fetchExternalEvents, range.from, range.to]);

  const handleDragStart = (e, taskId) => {
    e.dataTransfer.setData('taskId', taskId);
  };

  const handleDrop = async (e, dateString) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('taskId');
    if (!taskId) return;

    const previousTasks = [...tasks];
    const taskIndex = tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) return;

    const task = tasks[taskIndex];
    if (task.whenDate && toDateStr(task.whenDate) === dateString) return;

    const newDate = new Date(`${dateString}T12:00:00`);
    const updatedTasks = [...tasks];
    updatedTasks[taskIndex] = { ...task, whenDate: newDate.toISOString() };
    setTasks(updatedTasks);

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ whenDate: newDate.toISOString() }),
      });
      if (!res.ok) throw new Error('Update failed');
    } catch (err) {
      console.error(err);
      setTasks(previousTasks);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const stepNavigation = (direction) => {
    if (view === 'day') {
      setCurrentDate((d) => addDays(d, direction));
      setSelectedDay((d) => addDays(d, direction));
      return;
    }
    if (view === 'week') {
      setCurrentDate((d) => addDays(d, direction * 7));
      setSelectedDay((d) => addDays(d, direction * 7));
      return;
    }
    setCurrentDate(new Date(year, month + direction, 1, 12, 0, 0, 0));
  };

  const goToday = () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    setCurrentDate(today);
    setSelectedDay(today);
  };

  const selectedKey = toDateStr(selectedDay);
  const selectedTasks = tasks.filter(
    (task) => task.whenDate && toDateStr(task.whenDate) === selectedKey,
  );
  const selectedMeetings = meetings.filter(
    (meeting) =>
      meeting.meetingDate && toDateStr(meeting.meetingDate) === selectedKey,
  );
  const selectedExternal = visibleExternalEvents.filter(
    (event) => toDateStr(event.startAt) === selectedKey,
  );

  const upcomingTasks = tasks
    .filter((task) => task.whenDate)
    .map((task) => ({ ...task, date: new Date(task.whenDate) }))
    .filter((task) => task.date >= new Date())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, 7);
  const upcomingMeetings = meetings
    .filter((meeting) => meeting.meetingDate)
    .map((meeting) => ({ ...meeting, date: new Date(meeting.meetingDate) }))
    .filter((meeting) => meeting.date >= new Date())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, 7);
  const upcomingExternal = visibleExternalEvents
    .filter((event) => new Date(event.startAt) >= new Date())
    .slice(0, 7);

  const weekDays = useMemo(() => {
    const start = startOfWeek(currentDate);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }, [currentDate]);

  const dayDays = useMemo(() => [new Date(currentDate)], [currentDate]);

  const monthListDays = useMemo(() => {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return Array.from(
      { length: daysInMonth },
      (_, i) => new Date(year, month, i + 1, 12, 0, 0, 0),
    );
  }, [year, month]);

  const openDrawer = (event, task) => {
    event.stopPropagation();
    setDrawerTask(task);
  };
  const openMeetingDrawer = (event, meeting) => {
    event.stopPropagation();
    setDrawerMeeting(meeting);
  };
  const openExternalDrawer = (event, external) => {
    event.stopPropagation();
    setDrawerExternal(external);
  };
  const handleTaskUpdate = (updatedTask) => {
    setTasks((currentTasks) =>
      currentTasks.map((task) =>
        task.id === updatedTask.id ? { ...task, ...updatedTask } : task,
      ),
    );
    setDrawerTask((currentTask) =>
      currentTask?.id === updatedTask.id
        ? { ...currentTask, ...updatedTask }
        : currentTask,
    );
  };

  const handleToggleSource = useCallback((sourceId) => {
    setHiddenSourceIds((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }
      return next;
    });
  }, []);

  const handleViewChange = (nextView) => {
    setView(nextView);
    if (nextView === 'day') {
      setCurrentDate(new Date(selectedDay));
    }
  };

  return (
    <div className="space-y-5">
      <CalendarToolbar
        title={titleForView(view, currentDate)}
        view={view}
        onViewChange={handleViewChange}
        onPrev={() => stepNavigation(-1)}
        onNext={() => stepNavigation(1)}
        onToday={goToday}
        showExternal={showExternal}
        onToggleExternal={() => setShowExternal((v) => !v)}
        caldavSources={caldavSources}
        hiddenSourceIds={hiddenSourceIds}
        onToggleSource={handleToggleSource}
        syncStatus={syncStatus}
        refreshing={refreshing || loadingEvents}
        onRefresh={handleRefresh}
      />

      <div
        className={cn(
          'grid gap-5 transition-[grid-template-columns] duration-200',
          detailsOpen ? 'lg:grid-cols-[1fr_320px]' : 'lg:grid-cols-[1fr_44px]',
        )}
      >
        <div className="space-y-4 min-w-0">
          <div className="hidden md:block">
            {view === 'month' ? (
              <MonthGrid
                year={year}
                month={month}
                tasks={tasks}
                meetings={meetings}
                externalEvents={visibleExternalEvents}
                showExternal={showExternal}
                selectedDay={selectedDay}
                onSelectDay={setSelectedDay}
                onDropTask={handleDrop}
                onDragOver={handleDragOver}
                onDragStart={handleDragStart}
                onOpenTask={openDrawer}
                onOpenMeeting={openMeetingDrawer}
                onOpenExternal={openExternalDrawer}
              />
            ) : (
              <TimeGrid
                days={view === 'week' ? weekDays : dayDays}
                tasks={tasks}
                meetings={meetings}
                externalEvents={visibleExternalEvents}
                showExternal={showExternal}
                selectedDay={selectedDay}
                onSelectDay={(date) => {
                  setSelectedDay(date);
                  if (view === 'day') setCurrentDate(date);
                }}
                onDropTask={handleDrop}
                onDragOver={handleDragOver}
                onOpenTask={openDrawer}
                onOpenMeeting={openMeetingDrawer}
                onOpenExternal={openExternalDrawer}
              />
            )}
          </div>

          {/* Mobile: day timeline for day view; week selector + day timeline; month list */}
          <div className="space-y-3 md:hidden">
            {view === 'week' ? (
              <>
                <div className="flex gap-1 overflow-x-auto pb-1">
                  {weekDays.map((date) => {
                    const key = toDateStr(date);
                    const active = key === selectedKey;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={cn(
                          'min-w-[2.75rem] rounded-lg border px-2 py-2 text-center text-xs',
                          active
                            ? 'border-[var(--accent)] bg-[var(--accent-muted)] text-[var(--accent)]'
                            : 'border-[var(--border)] text-[var(--text-secondary)]',
                        )}
                        onClick={() => {
                          setSelectedDay(date);
                          setCurrentDate(date);
                        }}
                      >
                        <div>
                          {date.toLocaleDateString(undefined, {
                            weekday: 'narrow',
                          })}
                        </div>
                        <div className="font-semibold">{date.getDate()}</div>
                      </button>
                    );
                  })}
                </div>
                <TimeGrid
                  days={[selectedDay]}
                  tasks={tasks}
                  meetings={meetings}
                  externalEvents={visibleExternalEvents}
                  showExternal={showExternal}
                  selectedDay={selectedDay}
                  onSelectDay={setSelectedDay}
                  onDropTask={handleDrop}
                  onDragOver={handleDragOver}
                  onOpenTask={openDrawer}
                  onOpenMeeting={openMeetingDrawer}
                  onOpenExternal={openExternalDrawer}
                />
              </>
            ) : view === 'day' ? (
              <TimeGrid
                days={[currentDate]}
                tasks={tasks}
                meetings={meetings}
                externalEvents={visibleExternalEvents}
                showExternal={showExternal}
                selectedDay={selectedDay}
                onSelectDay={setSelectedDay}
                onDropTask={handleDrop}
                onDragOver={handleDragOver}
                onOpenTask={openDrawer}
                onOpenMeeting={openMeetingDrawer}
                onOpenExternal={openExternalDrawer}
              />
            ) : (
              <MobileDayList
                days={monthListDays}
                tasks={tasks}
                meetings={meetings}
                externalEvents={visibleExternalEvents}
                showExternal={showExternal}
                onOpenTask={openDrawer}
                onOpenMeeting={openMeetingDrawer}
                onOpenExternal={openExternalDrawer}
                onSelectDay={setSelectedDay}
              />
            )}
          </div>

          <UnscheduledTray
            tasks={tasks}
            search={search}
            setSearch={setSearch}
            priorityFilter={priorityFilter}
            setPriorityFilter={setPriorityFilter}
            projectFilter={projectFilter}
            setProjectFilter={setProjectFilter}
            sortBy={sortBy}
            setSortBy={setSortBy}
            showCompleted={showCompleted}
            setShowCompleted={setShowCompleted}
            clearFilters={clearFilters}
            onDragStart={handleDragStart}
            onOpenTask={openDrawer}
          />
        </div>

        <AgendaPanel
          open={detailsOpen}
          onToggle={setDetailsOpen}
          selectedDay={selectedDay}
          selectedTasks={selectedTasks}
          selectedMeetings={selectedMeetings}
          selectedExternal={selectedExternal}
          upcomingTasks={upcomingTasks}
          upcomingMeetings={upcomingMeetings}
          upcomingExternal={upcomingExternal}
          onOpenTask={openDrawer}
          onOpenMeeting={openMeetingDrawer}
          onOpenExternal={openExternalDrawer}
        />
      </div>

      {drawerTask && (
        <TaskDrawer
          task={drawerTask}
          onClose={() => setDrawerTask(null)}
          onTaskUpdate={handleTaskUpdate}
        />
      )}
      {drawerMeeting && (
        <MeetingDrawer
          meeting={drawerMeeting}
          readOnly
          onClose={() => setDrawerMeeting(null)}
          onMeetingUpdate={(updatedMeeting) =>
            setDrawerMeeting((current) =>
              current?.id === updatedMeeting.id
                ? { ...current, ...updatedMeeting }
                : current,
            )
          }
        />
      )}
      {drawerExternal && (
        <ExternalEventDrawer
          event={drawerExternal}
          onClose={() => setDrawerExternal(null)}
        />
      )}
    </div>
  );
}
