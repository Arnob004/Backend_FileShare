import { server } from "./app.js";

const port = 5000;

server.listen(port, () => {
  console.log(`server run on http://localhost:${port}`);
});
