import { Runtime } from "foldkit";
import { init, Model, update, view } from "./main";

Runtime.run(Runtime.makeApplication({ Model, init, update, view, container: document.getElementById("root") }));
