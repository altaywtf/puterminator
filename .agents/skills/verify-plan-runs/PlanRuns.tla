---- MODULE PlanRuns ----
EXTENDS Naturals, FiniteSets

CONSTANTS Steps, Trash, MaxRetries

States == {"none", "queued", "running", "done", "failed"}
InUndo(st, mb) == st = "done" \/ (st = "failed" /\ mb)

VARIABLES status, step, maybe, ustep, umaybe, lib, fiber, inflight, skip, eitherEnd, writes, grants, retries

vars == <<status, step, maybe, ustep, umaybe, lib, fiber, inflight, skip, eitherEnd, writes, grants, retries>>

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

Apply ==
  /\ status = "proposed" /\ fiber = "idle"
  /\ status' = "applying"
  /\ step' = [i \in Steps |-> "queued"]
  /\ grants' = [i \in Steps |-> grants[i] + 1]
  /\ fiber' = "precheck" /\ eitherEnd' = FALSE
  /\ UNCHANGED <<maybe, ustep, umaybe, lib, inflight, skip, writes, retries>>

Retry ==
  /\ status \in {"done", "undone"} /\ fiber = "idle" /\ retries < MaxRetries
  /\ status' = IF status = "undone" THEN "undoing" ELSE "applying"
  /\ SetCur([i \in Steps |-> IF Cur[i] = "failed" THEN "queued" ELSE Cur[i]], CurMaybe)
  /\ grants' = [i \in Steps |-> IF Cur[i] = "failed" THEN grants[i] + 1 ELSE grants[i]]
  /\ retries' = retries + 1
  /\ fiber' = "precheck" /\ eitherEnd' = TRUE
  /\ UNCHANGED <<lib, inflight, skip, writes>>

Undo ==
  /\ status = "done" /\ fiber = "idle"
  /\ \E i \in Steps : InUndo(step[i], maybe[i])
  /\ status' = "undoing"
  /\ ustep' = [i \in Steps |-> IF InUndo(step[i], maybe[i]) THEN "queued" ELSE "none"]
  /\ umaybe' = [i \in Steps |-> FALSE]
  /\ grants' = [i \in Steps |-> IF InUndo(step[i], maybe[i]) THEN grants[i] + 1 ELSE grants[i]]
  /\ fiber' = "precheck" /\ eitherEnd' = TRUE
  /\ UNCHANGED <<step, maybe, lib, inflight, skip, writes, retries>>

PrecheckPass ==
  /\ fiber = "precheck"
  /\ skip' = IF Undoing THEN {} ELSE
             {i \in Steps : eitherEnd /\ Cur[i] = "queued" /\ CurMaybe[i] /\ i \in Trash /\ lib[i] = "changed"}
  /\ fiber' = "writing"
  /\ UNCHANGED <<status, step, maybe, ustep, umaybe, lib, inflight, eitherEnd, writes, grants, retries>>

PrecheckFail ==
  /\ fiber = "precheck"
  /\ SetCur(FailUnfinished(Cur), CurMaybe)
  /\ status' = Finished /\ fiber' = "idle"
  /\ UNCHANGED <<lib, inflight, skip, eitherEnd, writes, grants, retries>>

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

WriteOk ==
  /\ fiber = "awaiting"
  /\ lib' = [lib EXCEPT ![inflight] = Target]
  /\ SetCur([Cur EXCEPT ![inflight] = "done"], CurMaybe)
  /\ inflight' = 0 /\ fiber' = "writing"
  /\ UNCHANGED <<status, skip, eitherEnd, writes, grants, retries>>

WriteRefused ==
  /\ fiber = "awaiting"
  /\ SetCur([Cur EXCEPT ![inflight] = "failed"], CurMaybe)
  /\ inflight' = 0 /\ fiber' = "writing"
  /\ UNCHANGED <<status, lib, skip, eitherEnd, writes, grants, retries>>

WriteLost ==
  /\ fiber = "awaiting"
  /\ \E landed \in BOOLEAN : lib' = IF landed THEN [lib EXCEPT ![inflight] = Target] ELSE lib
  /\ SetCur([Cur EXCEPT ![inflight] = "failed"], [CurMaybe EXCEPT ![inflight] = TRUE])
  /\ inflight' = 0 /\ fiber' = "writing"
  /\ UNCHANGED <<status, skip, eitherEnd, writes, grants, retries>>

LoopDone ==
  /\ fiber = "writing" /\ Queued = {}
  /\ fiber' = "final"
  /\ UNCHANGED <<status, step, maybe, ustep, umaybe, lib, inflight, skip, eitherEnd, writes, grants, retries>>

Finish ==
  /\ fiber = "final"
  /\ status' = Finished /\ fiber' = "idle"
  /\ UNCHANGED <<step, maybe, ustep, umaybe, lib, inflight, skip, eitherEnd, writes, grants, retries>>

Halt ==
  /\ fiber \in {"precheck", "awaiting", "final"}
  /\ \E landed \in BOOLEAN :
       lib' = IF fiber = "awaiting" /\ landed THEN [lib EXCEPT ![inflight] = Target] ELSE lib
  /\ SetCur(FailUnfinished(Cur), FailUnfinishedMaybe(Cur, CurMaybe))
  /\ status' = Finished /\ fiber' = "idle" /\ inflight' = 0
  /\ UNCHANGED <<skip, eitherEnd, writes, grants, retries>>

Next ==
  \/ Apply \/ Retry \/ Undo
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

NoSilentWrite == \A i \in Steps : writes[i] <= grants[i]

NoOrphanRunning == fiber = "idle" => \A i \in Steps : step[i] # "running" /\ ustep[i] # "running"

UndoSeesEveryWrite ==
  (status = "done" /\ fiber = "idle") =>
    \A i \in Steps : lib[i] = "changed" => (step[i] = "done" \/ (step[i] = "failed" /\ maybe[i]))

UndoLeavesNothing ==
  (status = "undone" /\ fiber = "idle" /\ \A i \in Steps : ustep[i] \in {"none", "done"})
    => \A i \in Steps : lib[i] = "orig"
====
