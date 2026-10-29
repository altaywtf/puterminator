import { Runtime } from "foldkit";
import { init, Model, managedResources, subscriptions, update } from "./main";
import { view } from "./view";

Runtime.run(
  Runtime.makeApplication({
    Model,
    init,
    update,
    view,
    subscriptions,
    managedResources,
    container: document.getElementById("root"),
  }),
);
