---- MODULE PlanRuns ----
EXTENDS Naturals, FiniteSets

CONSTANTS Steps, Trash, MaxRetries, MaxDue

States == {"none", "queued", "running", "done", "failed"}
Dues == 1..MaxDue
InUndo(st, mb) == st = "done" \/ (st = "failed" /\ mb)

VARIABLES status, step, maybe, ustep, umaybe, lib, fiber, inflight, skip, eitherEnd, writes, grants, retries,
          source, rule, due, ran, runs

plan == <<status, step, maybe, ustep, umaybe, lib, fiber, inflight, skip, eitherEnd, writes, grants, retries>>
ruleVars == <<source, rule, due, ran, runs>>
vars == <<plan, ruleVars>>

Undoing == status \in {"undoing", "undone"}
Cur == IF Undoing THEN ustep ELSE step
CurMaybe == IF Undoing THEN umaybe ELSE maybe
Finished == IF Undoing THEN "undone" ELSE "done"
Target == IF Undoing THEN "orig" ELSE "changed"

SetCur(s, m) ==
  IF Undoing
  THEN /\ ustep' = s /\ umaybe' = m /\ UNCHANGED <<step, maybe>>
  ELSE /\ step' = s /\ maybe' = m /\ UNCHANGED <<ustep, umaybe>>

FailUnfinished(s) == [i \in Steps |-> IF s[i] \in {"running", "queued"} THEN "failed" ELSE s[i]]
FailUnfinishedMaybe(s, m) == [i \in Steps |-> m[i] \/ s[i] = "running"]

Init ==
  /\ status = "proposed"
  /\ step = [i \in Steps |-> "none"]
  /\ maybe = [i \in Steps |-> FALSE]
  /\ ustep = [i \in Steps |-> "none"]
  /\ umaybe = [i \in Steps |-> FALSE]
  /\ lib = [i \in Steps |-> "orig"]
  /\ fiber = "idle"
  /\ inflight = 0
  /\ skip = {}
  /\ eitherEnd = FALSE
  /\ writes = [i \in Steps |-> 0]
  /\ grants = [i \in Steps |-> 0]
  /\ retries = 0
  /\ source = "chat"
  /\ rule = "active"
  /\ due = 1
  /\ ran = {}
  /\ runs = [d \in Dues |-> 0]

Apply ==
  /\ status = "proposed" /\ fiber = "idle" /\ source = "chat"
  /\ status' = "applying"
  /\ step' = [i \in Steps |-> "queued"]
  /\ grants' = [i \in Steps |-> grants[i] + 1]
  /\ fiber' = "precheck" /\ eitherEnd' = FALSE
  /\ UNCHANGED <<maybe, ustep, umaybe, lib, inflight, skip, writes, retries>>
  /\ UNCHANGED ruleVars

Due ==
  /\ rule = "active" /\ due \notin ran
  /\ fiber = "idle" /\ status \in {"proposed", "done", "undone"}
  /\ status' = "applying"
  /\ step' = [i \in Steps |-> "queued"] /\ maybe' = [i \in Steps |-> FALSE]
  /\ ustep' = [i \in Steps |-> "none"] /\ umaybe' = [i \in Steps |-> FALSE]
  /\ lib' = [i \in Steps |-> "orig"]
  /\ writes' = [i \in Steps |-> 0] /\ grants' = [i \in Steps |-> 1] /\ retries' = 0
  /\ fiber' = "precheck" /\ eitherEnd' = FALSE /\ inflight' = 0 /\ skip' = {}
  /\ source' = "rule" /\ ran' = ran \cup {due} /\ runs' = [runs EXCEPT ![due] = @ + 1]
  /\ UNCHANGED <<rule, due>>

Reschedule ==
  /\ due \in ran /\ due < MaxDue
  /\ due' = due + 1
  /\ UNCHANGED <<plan, source, rule, ran, runs>>

Pause ==
  /\ rule = "active"
  /\ rule' = "paused"
  /\ UNCHANGED <<plan, source, due, ran, runs>>

Approve ==
  /\ rule = "paused"
  /\ rule' = "active"
  /\ UNCHANGED <<plan, source, due, ran, runs>>

Retry ==
  /\ status \in {"done", "undone"} /\ fiber = "idle" /\ retries < MaxRetries
  /\ status' = IF status = "undone" THEN "undoing" ELSE "applying"
  /\ SetCur([i \in Steps |-> IF Cur[i] = "failed" THEN "queued" ELSE Cur[i]], CurMaybe)
  /\ grants' = [i \in Steps |-> IF Cur[i] = "failed" THEN grants[i] + 1 ELSE grants[i]]
  /\ retries' = retries + 1
  /\ fiber' = "precheck" /\ eitherEnd' = TRUE
  /\ UNCHANGED <<lib, inflight, skip, writes>>
  /\ UNCHANGED ruleVars

Undo ==
  /\ status = "done" /\ fiber = "idle"
  /\ \E i \in Steps : InUndo(step[i], maybe[i])
  /\ status' = "undoing"
  /\ ustep' = [i \in Steps |-> IF InUndo(step[i], maybe[i]) THEN "queued" ELSE "none"]
  /\ umaybe' = [i \in Steps |-> FALSE]
  /\ grants' = [i \in Steps |-> IF InUndo(step[i], maybe[i]) THEN grants[i] + 1 ELSE grants[i]]
  /\ fiber' = "precheck" /\ eitherEnd' = TRUE
  /\ UNCHANGED <<step, maybe, lib, inflight, skip, writes, retries>>
  /\ UNCHANGED ruleVars

PrecheckPass ==
  /\ fiber = "precheck"
  /\ skip' = IF Undoing THEN {} ELSE
             {i \in Steps : eitherEnd /\ Cur[i] = "queued" /\ CurMaybe[i] /\ i \in Trash /\ lib[i] = "changed"}
  /\ fiber' = "writing"
  /\ UNCHANGED <<status, step, maybe, ustep, umaybe, lib, inflight, eitherEnd, writes, grants, retries>>
  /\ UNCHANGED ruleVars

PrecheckFail ==
  /\ fiber = "precheck"
  /\ SetCur(FailUnfinished(Cur), CurMaybe)
  /\ status' = Finished /\ fiber' = "idle"
  /\ UNCHANGED <<lib, inflight, skip, eitherEnd, writes, grants, retries>>
  /\ UNCHANGED ruleVars

Queued == {i \in Steps : Cur[i] = "queued"}
Next1 == IF Undoing
         THEN CHOOSE i \in Queued : \A j \in Queued : j <= i
         ELSE CHOOSE i \in Queued : \A j \in Queued : i <= j

StartStep ==
  /\ fiber = "writing" /\ Queued # {}
  /\ LET i == Next1 IN
     IF i \in skip
     THEN /\ SetCur([Cur EXCEPT ![i] = "done"], CurMaybe)
          /\ UNCHANGED <<fiber, inflight, writes>>
     ELSE /\ SetCur([Cur EXCEPT ![i] = "running"], CurMaybe)
          /\ writes' = [writes EXCEPT ![i] = @ + 1]
          /\ inflight' = i /\ fiber' = "awaiting"
  /\ UNCHANGED <<status, lib, skip, eitherEnd, grants, retries>>
  /\ UNCHANGED ruleVars

WriteOk ==
  /\ fiber = "awaiting"
  /\ lib' = [lib EXCEPT ![inflight] = Target]
  /\ SetCur([Cur EXCEPT ![inflight] = "done"], CurMaybe)
  /\ inflight' = 0 /\ fiber' = "writing"
  /\ UNCHANGED <<status, skip, eitherEnd, writes, grants, retries>>
  /\ UNCHANGED ruleVars

WriteRefused ==
  /\ fiber = "awaiting"
  /\ SetCur([Cur EXCEPT ![inflight] = "failed"], CurMaybe)
  /\ inflight' = 0 /\ fiber' = "writing"
  /\ UNCHANGED <<status, lib, skip, eitherEnd, writes, grants, retries>>
  /\ UNCHANGED ruleVars

WriteLost ==
  /\ fiber = "awaiting"
  /\ \E landed \in BOOLEAN : lib' = IF landed THEN [lib EXCEPT ![inflight] = Target] ELSE lib
  /\ SetCur([Cur EXCEPT ![inflight] = "failed"], [CurMaybe EXCEPT ![inflight] = TRUE])
  /\ inflight' = 0 /\ fiber' = "writing"
  /\ UNCHANGED <<status, skip, eitherEnd, writes, grants, retries>>
  /\ UNCHANGED ruleVars

LoopDone ==
  /\ fiber = "writing" /\ Queued = {}
  /\ fiber' = "final"
  /\ UNCHANGED <<status, step, maybe, ustep, umaybe, lib, inflight, skip, eitherEnd, writes, grants, retries>>
  /\ UNCHANGED ruleVars

Finish ==
  /\ fiber = "final"
  /\ status' = Finished /\ fiber' = "idle"
  /\ UNCHANGED <<step, maybe, ustep, umaybe, lib, inflight, skip, eitherEnd, writes, grants, retries>>
  /\ UNCHANGED ruleVars

Halt ==
  /\ fiber \in {"precheck", "writing", "awaiting", "final"}
  /\ \E landed \in BOOLEAN :
       lib' = IF fiber = "awaiting" /\ landed THEN [lib EXCEPT ![inflight] = Target] ELSE lib
  /\ SetCur(FailUnfinished(Cur), FailUnfinishedMaybe(Cur, CurMaybe))
  /\ status' = Finished /\ fiber' = "idle" /\ inflight' = 0
  /\ UNCHANGED <<skip, eitherEnd, writes, grants, retries>>
  /\ UNCHANGED ruleVars

Next ==
  \/ Apply \/ Retry \/ Undo
  \/ Due \/ Reschedule \/ Pause \/ Approve
  \/ PrecheckPass \/ PrecheckFail
  \/ StartStep \/ WriteOk \/ WriteRefused \/ WriteLost
  \/ LoopDone \/ Finish \/ Halt

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ status \in {"proposed", "applying", "done", "undoing", "undone"}
  /\ step \in [Steps -> States] /\ ustep \in [Steps -> States]
  /\ maybe \in [Steps -> BOOLEAN] /\ umaybe \in [Steps -> BOOLEAN]
  /\ lib \in [Steps -> {"orig", "changed"}]
  /\ fiber \in {"idle", "precheck", "writing", "awaiting", "final"}
  /\ source \in {"chat", "rule"} /\ rule \in {"active", "paused"}
  /\ due \in Dues /\ ran \subseteq Dues /\ runs \in [Dues -> Nat]

NoSilentWrite == \A i \in Steps : writes[i] <= grants[i]

OneRunPerDue == \A d \in Dues : runs[d] <= 1

NoOrphanRunning == fiber = "idle" => \A i \in Steps : step[i] # "running" /\ ustep[i] # "running"

UndoSeesEveryWrite ==
  (status = "done" /\ fiber = "idle") =>
    \A i \in Steps : lib[i] = "changed" => (step[i] = "done" \/ (step[i] = "failed" /\ maybe[i]))

UndoLeavesNothing ==
  (status = "undone" /\ fiber = "idle" /\ \A i \in Steps : ustep[i] \in {"none", "done"})
    => \A i \in Steps : lib[i] = "orig"

PausedRuleStartsNothing == [][runs' # runs => rule = "active"]_vars
====
