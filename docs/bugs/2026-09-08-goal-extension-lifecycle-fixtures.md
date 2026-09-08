# Goal extension lifecycle fixture migration

Completed-watching fixtures reach completion through the public planned.v1
lifecycle helpers, so their managed-workspace receipts are canonical service
receipts rather than hand-written fixture data.

The legacy blocked-supersede fixture retains only its legal legacy blocked
state.  It no longer mixes a legacy event generation with `planned.v1` managed
workspace disposition receipts.
