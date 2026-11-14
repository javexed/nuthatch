# Dashboards

A dashboard is a title and a list of boxes. Anyone who logs in can make
their own, and share one with everyone.

## Boxes

| Box | Shows |
|---|---|
| Totals by state | how many hosts or services are in each state, and how many problems nobody has taken care of; of one host group if wanted |
| A list of problems | the hosts or services that are not OK, the newest first; only the unhandled ones if wanted |
| One host or service | its state, its output, and for how long |
| The latest alerts or notifications | lines of the log, of the last hours |

Boxes are added, moved and taken away under "Change". They follow what
happens as every other page does.

## Whose

- A dashboard is changed and deleted by its owner only.
- A shared dashboard can be opened by everyone who logs in. A dashboard
  holds no data, only what its boxes ask for, and each box asks as the
  one who looks: the same dashboard shows an administrator everything and
  another user what is theirs. A box about a host that is not one's own
  says so.

## Kept

In nuthatch's store, not in the engines' config. Removing a user's
dashboards means deleting them there.

## Not done

A free canvas, maps, business processes, graphs of performance data over
time, and sharing with some users only.

## The grid

Panels sit on a grid of 12 columns. In edit mode a panel is moved by the
grip in its header and resized by its lower right corner; whatever is in
the way moves down, and everything rises as far as it can. The gear opens
a panel's settings. On a narrow screen the panels are one column, in
order from the top.

A panel is added from the tray above the grid: dragged to where it should
go (a dashed box shows where it lands), or clicked to go to the first free
place. Its settings offer the engines' hosts, services and host groups to
choose from, and a name not among them is marked; a number or graph offers
the metrics the check reports, with their values now.

**Add to dashboard** on a host's or service's page puts it on a dashboard,
or a new one: as its status, or one of its metrics as a number or a graph.

Panels: a number of a check's performance data with a line of how it
went (from the graphs, `[graphs]`), a graph of one number, problems,
totals by state (of a host group, if given), one host or service, and the
latest alerts or notifications.

A shared dashboard is changed by anyone who can open it, and stays
shared; only its owner deletes it or stops sharing it.

Wall shows the panels alone, full screen; Escape leaves it.

