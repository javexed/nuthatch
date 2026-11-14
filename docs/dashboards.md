# Dashboards

A dashboard is panels on a grid of 12 columns, one time range for all of
them, and maybe a host chosen at the top. Anyone who logs in has their
own, and may share one with everyone.

## Starting

Everyone has an **Overview** from the start: all hosts, the service
problems, the alerts, and each host group. **New** makes a whole
dashboard in one click:

- **Overview**, again.
- **For a host group**: its hosts, problems, availability, what recovered,
  and a number of each host's own check.
- **For a host**: one host, chosen at the top, so that one dashboard
  serves every host; a graph of each of its services' first number.
- **Blank**.
- **Import**: a file another dashboard was exported to.

**Pin** on a host's or service's page puts its status on the dashboard
pinned to last (or changed last, or a new one), and each graph there has
a Pin for that number. **Undo** takes it off again; **Change** moves it.

## Panels

| Panel | Shows |
|---|---|
| Hosts | everything or a host group: counts and a tile per host, with a dot when one of its services is not OK; one host: its card and a tile per service; one service: its card |
| Problems | hosts or services: problems nobody has taken care of, acknowledged, in a downtime, or recovered within the range |
| Number | the first number of a check, coloured by its thresholds (with a bar when it has a maximum) |
| Graph | numbers of checks over the range, lines of one unit together |
| Alerts | alerts or notifications within the range |
| Uptime | the share of the range up or OK; for a group, the lowest hosts too |
| Note | text; its web addresses are links |

A Number and a Graph are one panel: made larger, a number becomes a
graph, and smaller, a graph a number.

What can be worked out is not asked: a panel's title comes from what it
shows, lists show as many rows as fit, and a metric is a number or a
graph by its size. A panel's outline takes the colour of the worst it
shows. What a panel shows is chosen from a list (everything, the host
groups, the hosts; › opens a host's services or numbers), or by a few
words: every host group, host, service or number with them all.

## Changing

Whoever may change a dashboard changes it in place, on a wide screen:
**+ Panel** opens the tray (open already on an empty dashboard), whose panels are dragged onto the grid (a
dashed box shows where they land) or clicked; a panel moves by its grip
and resizes by its corner; the gear opens its settings; ⧉ duplicates it.
Every change is kept at once; **Undo** (or Ctrl+Z) takes back one step.
The ⋯ menu has sharing, the host chooser, **Export** and **Delete**.

**Wall** shows the panels alone, full screen. On the list of dashboards,
ticking several and **Wall** shows them in turn, every so many seconds.

## Whose

- A dashboard is changed by its owner, and a shared one by anyone; only
  its owner deletes it.
- A dashboard holds no data, only what its panels ask for, and each panel
  asks as the one who looks: the same dashboard shows an administrator
  everything and another user what is theirs.
- Kept in nuthatch's store, not in the engines' config.
