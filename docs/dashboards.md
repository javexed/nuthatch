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
