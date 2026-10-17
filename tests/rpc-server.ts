import { SearchNamespace as Coordinator } from "../src/worker";
export { KanninRpc, Terms, Segments } from "../src/worker";

export class SearchNamespace extends Coordinator {
  override fetch() {
    return Promise.resolve(new Response("Coordinator HTTP is disabled", { status: 502 }));
  }
}
export default {
  fetch() {
    return new Response("Worker HTTP is disabled", { status: 502 });
  },
};
