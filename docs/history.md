# History and availability

## History

The History page shows lines of the engines' logs over a span of time, the
newest first: alerts, notifications, or everything. Each host's and
service's own page shows its last day of alerts.

A user who is limited to their own hosts and services gets the lines
about those: alerts, notifications, passive checks and state lines. The
lines about the program itself, and the lines of external commands, are
for users who may see all hosts (see [permissions](permissions.md)).

## Availability

The Availability page says how much of a span of time each host or
service spent in each state, the worst first, and gives the table as a
CSV file. The numbers are the engines': their state history
(`statehist`), summed per host and service.

- A share is of the time the engine has a state for. Time before the
  engine knew of an object counts as "not monitored" on Naemon and is
  left out of the shares; checkd counts that time as the first state it
  knows of.
- States count whether soft or hard, in a downtime or not. Leaving
  downtimes out, counting hard states only, and report timeperiods are
  not done.
- The engines work the history out from their logs on every asking,
  which takes time over long spans; nuthatch waits up to two minutes for
  it. The page asks when it is opened or narrowed, not on every change.
- Naemon needs `log_initial_states=1` to know the state of what did not
  change within the span of a log file. checkd reads its log from its
  store, the newest 200,000 lines.

## Tested

A browser test submits a sequence of states for a service and its host
on each engine, and compares what the engine and the page say with the
seconds the test itself counted, within one second per state; then it
restarts the engine and asks again.
