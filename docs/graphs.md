# Graphs

A host's or service's page shows the numbers its check gives (its
performance data: a response time, a load, how full a disk is) as small
graphs over the last 6 hours, 24 hours or 7 days: one line to a graph,
each on its own scale, with the highest and lowest value at the edges and
the value under the pointer or finger.

## Setting it up

    [graphs]
    days = 7

nuthatch then asks each of its backends once a minute for what was
checked since, and keeps each number with the time of its check for that
many days (1 to 31), in an SQLite file beside the store
(`<store>-graphs`). Without `[graphs]` nothing is kept and no graph is
shown.

- At most 12 numbers of one check are kept.
- A graph of more than 240 points is averaged down to that.
- Where checks are missing for a while, the line breaks.
- A user sees the graphs of the hosts and services they see.
- A site's graphs come from that site's nuthatch, which keeps its own.

## How much it holds

A point is some tens of bytes. A service checked every five minutes with
two numbers makes 576 points a day: a hundred such services over a week
come to some 400,000 points, a few megabytes. For thousands of services,
or months of history, send the performance data to a time-series
database instead (checkd writes to Graphite and InfluxDB itself) and
look at it there; nuthatch's history is meant to answer "what was this
doing over the last days", no more.
