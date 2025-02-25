// filepath: /Users/jesseb0rn/Documents/repos/rasterrouting-web/src/worker.ts
import { runSearch } from './main'; // Adjust the import based on your project structure

self.onmessage = (event) => {
  const { endpointA, endpointB } = event.data;

  // Execute the runSearch function with the provided endpoints
  const result = runSearch(endpointA, endpointB);

  // Post the result back to the main thread
  self.postMessage(result);
};