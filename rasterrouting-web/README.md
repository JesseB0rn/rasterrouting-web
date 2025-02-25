# rasterrouting-web/rasterrouting-web/README.md

# Raster Routing Web Application

This project is a web application that utilizes MapLibre GL for rendering maps and implements a pathfinding algorithm to find routes based on elevation data. The application offloads computationally expensive tasks to a web worker for improved performance.

## Project Structure

- **src/main.ts**: The main entry point of the application. Initializes the map and handles user interactions. Contains the `runSearch` function for pathfinding logic.
  
- **src/worker.ts**: A web worker that offloads the `runSearch` function. Listens for messages from the main thread, executes the pathfinding logic, and posts results back.

- **src/tilebelt.ts**: Utility functions related to tile calculations, such as converting between tile coordinates and geographical coordinates.

- **tsconfig.json**: TypeScript configuration file specifying compiler options and files to include in the compilation.

- **package.json**: npm configuration file listing dependencies and scripts for the project.

## Getting Started

1. **Clone the Repository**:
   ```
   git clone <repository-url>
   cd rasterrouting-web
   ```

2. **Install Dependencies**:
   ```
   npm install
   ```

3. **Run the Application**:
   ```
   npm run dev
   ```

4. **Build the Application**:
   ```
   npm run build
   ```

## Offloading Pathfinding to a Web Worker

To improve performance, the `runSearch` function has been offloaded to a web worker. The following steps outline the implementation:

1. **Worker Setup**: The worker is created in `src/worker.ts`, which listens for messages and executes the `runSearch` function.

2. **Parameter Handling**: The `runSearch` function is modified to accept parameters and return results in a format suitable for communication with the main thread.

3. **Main Thread Communication**: In `src/main.ts`, a new instance of the worker is created, and messages are posted with the necessary parameters for `runSearch`.

4. **Result Handling**: An event listener in `src/main.ts` processes messages from the worker, containing the results of the pathfinding operation.

5. **Testing**: Ensure the worker correctly offloads computation and returns results as expected.

## License

This project is licensed under the MIT License. See the LICENSE file for details.