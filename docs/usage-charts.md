# Usage chart continuity

The Usage charts select accounts by `harness:account` registry identity. Display labels are not
keys: two accounts named Principal remain separate, including across harnesses. The server writes
plan history with the same identity; labels cannot reconstruct the origin of an already mixed history.

Lines break on changed reset ids (allowing five minutes of timestamp jitter), decreasing usage,
missing readings, or more than one hour without samples. At another account’s sample timestamp,
a continuous line is interpolated linearly, matching its drawn geometry. These intermediate values
are interpolated, not additional observed readings. Chart nulls remain breaks.

Peak detection segments the original readings before coarsening to half-hour intervals, so a reset
or gap hidden between two retained samples never becomes an apparent climb. Rates use only
consecutive observations within a continuous segment. No persisted history is rewritten by the UI.
