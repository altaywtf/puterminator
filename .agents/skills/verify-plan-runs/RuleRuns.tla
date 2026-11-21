---- MODULE RuleRuns ----
EXTENDS Naturals

CONSTANTS MaxDue, MaxPreviews

Dues == 1..MaxDue

VARIABLES rule, phase, nextDue, issued, cur, runs, needsApproval, plan, failed, preview

vars == <<rule, phase, nextDue, issued, cur, runs, needsApproval, plan, failed, preview>>

Init ==
  /\ rule = "previewed"
  /\ phase = "none"
  /\ nextDue = 0
  /\ issued = 0
  /\ cur = 0
  /\ runs = [d \in Dues |-> 0]
  /\ needsApproval = TRUE
  /\ plan = "idle"
  /\ failed = FALSE
  /\ preview = 1

Issue ==
  IF issued < MaxDue THEN nextDue' = issued + 1 /\ issued' = issued + 1 ELSE nextDue' = 0 /\ issued' = issued

Approve ==
  /\ \E shown \in 1..preview :
       /\ shown = preview
       /\ rule = "previewed" /\ plan # "running"
       /\ rule' = "waiting" /\ Issue /\ needsApproval' = (needsApproval /\ shown # preview)
  /\ UNCHANGED <<phase, cur, runs, plan, failed, preview>>

Preview ==
  /\ rule = "paused" /\ preview < MaxPreviews
  /\ rule' = "previewed" /\ preview' = preview + 1
  /\ UNCHANGED <<phase, nextDue, issued, cur, runs, needsApproval, plan, failed>>

Pause ==
  /\ rule \in {"waiting", "checking", "applying"}
  /\ rule' = "paused" /\ phase' = "none" /\ nextDue' = 0 /\ needsApproval' = TRUE
  /\ UNCHANGED <<issued, cur, runs, plan, failed, preview>>

Deliver ==
  /\ \E d \in 1..issued : d = nextDue /\ cur' = d
  /\ rule = "waiting"
  /\ rule' = "checking" /\ Issue
  /\ UNCHANGED <<phase, runs, needsApproval, plan, failed, preview>>

CheckLater ==
  /\ rule = "checking" /\ phase = "none"
  /\ rule' = "waiting" /\ Issue
  /\ UNCHANGED <<phase, cur, runs, needsApproval, plan, failed, preview>>

CheckNothing ==
  /\ rule = "checking" /\ phase = "none"
  /\ rule' = "waiting"
  /\ UNCHANGED <<phase, nextDue, issued, cur, runs, needsApproval, plan, failed, preview>>

CheckStop ==
  /\ rule = "checking" /\ phase = "none"
  /\ rule' = "paused" /\ nextDue' = 0 /\ needsApproval' = TRUE
  /\ UNCHANGED <<phase, issued, cur, runs, plan, failed, preview>>

Mark ==
  /\ rule = "checking" /\ phase = "none"
  /\ phase' = "marked"
  /\ UNCHANGED <<rule, nextDue, issued, cur, runs, needsApproval, plan, failed, preview>>

Launch ==
  /\ rule = "checking" /\ phase = "marked" /\ plan # "running"
  /\ plan' = "running" /\ failed' = FALSE
  /\ phase' = "launched" /\ runs' = [runs EXCEPT ![cur] = @ + 1]
  /\ UNCHANGED <<rule, nextDue, issued, cur, needsApproval, preview>>

Fizzle ==
  /\ rule = "checking" /\ phase = "marked"
  /\ rule' = "waiting" /\ phase' = "none" /\ Issue
  /\ UNCHANGED <<cur, runs, needsApproval, plan, failed, preview>>

Started ==
  /\ rule = "checking" /\ phase = "launched"
  /\ rule' = "applying" /\ phase' = "none"
  /\ UNCHANGED <<nextDue, issued, cur, runs, needsApproval, plan, failed, preview>>

Delete ==
  /\ rule # "deleted" /\ plan # "running"
  /\ rule' = "deleted" /\ phase' = "none" /\ nextDue' = 0 /\ needsApproval' = TRUE
  /\ UNCHANGED <<issued, cur, runs, plan, failed, preview>>

UndoRun ==
  /\ plan = "settled"
  /\ plan' = "running" /\ needsApproval' = TRUE
  /\ rule' = IF rule \in {"waiting", "checking", "applying"} THEN "paused" ELSE rule
  /\ nextDue' = IF rule \in {"waiting", "checking", "applying"} THEN 0 ELSE nextDue
  /\ phase' = IF rule \in {"waiting", "checking", "applying"} THEN "none" ELSE phase
  /\ UNCHANGED <<issued, cur, runs, failed, preview>>

PlanEnds ==
  /\ plan = "running"
  /\ plan' = "settled" /\ failed' \in BOOLEAN
  /\ needsApproval' = (needsApproval \/ failed')
  /\ UNCHANGED <<rule, phase, nextDue, issued, cur, runs, preview>>

Settle ==
  /\ rule = "applying" /\ plan = "settled"
  /\ IF failed
     THEN rule' = "paused" /\ nextDue' = 0
     ELSE rule' = "waiting" /\ UNCHANGED nextDue
  /\ UNCHANGED <<phase, issued, cur, runs, needsApproval, plan, failed, preview>>

Evict ==
  /\ IF rule = "checking" /\ phase = "none"
     THEN rule' = "waiting" /\ UNCHANGED nextDue
     ELSE IF rule \in {"checking", "applying"}
     THEN rule' = "paused" /\ nextDue' = 0
     ELSE UNCHANGED <<rule, nextDue>>
  /\ needsApproval' = (needsApproval \/ plan = "running" \/ (rule = "checking" /\ phase # "none"))
  /\ phase' = "none"
  /\ plan' = IF plan = "running" THEN "settled" ELSE plan
  /\ failed' = (failed \/ plan = "running")
  /\ UNCHANGED <<issued, cur, runs, preview>>

Next ==
  \/ Approve \/ Preview \/ Pause \/ Deliver
  \/ CheckLater \/ CheckNothing \/ CheckStop
  \/ Mark \/ Launch \/ Fizzle \/ Started
  \/ PlanEnds \/ Settle \/ Evict \/ Delete \/ UndoRun

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ rule \in {"previewed", "waiting", "checking", "applying", "paused", "deleted"}
  /\ phase \in {"none", "marked", "launched"}
  /\ nextDue \in 0..MaxDue /\ issued \in 0..MaxDue /\ cur \in 0..MaxDue
  /\ runs \in [Dues -> Nat] /\ needsApproval \in BOOLEAN
  /\ plan \in {"idle", "running", "settled"} /\ failed \in BOOLEAN /\ preview \in 1..MaxPreviews

OneRunPerDue == \A d \in Dues : runs[d] <= 1

NoRunWithoutApproval == [][runs' # runs => ~needsApproval]_vars
====
