require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
// Import our tree generators
const {
  BaseJsonTreeGenerator,
  FileSystemJsonTreeGenerator,
  GitHubJsonTreeGenerator,
} = require("./JsonTreeGenerator");

const {
  BaseTreeGenerator,
  TreeGenerator,
  GitHubTreeGenerator,
} = require("./TreeGenerator");

const app = express();

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// Helper function to generate documentation
async function generateDevDocs(tree, repoInfo) {
  // Documentation generation logic moved to a separate module if needed
  const timestamp = new Date().toISOString();
  const docTemplate = {
    metadata: {
      generatedAt: timestamp,
      repository: repoInfo,
      lastUpdated: repoInfo.repository?.updated_at || timestamp,
    },
    projectStructure: {
      overview: {
        sourceFiles: [],
        testFiles: [],
        configFiles: [],
        components: [],
        utilities: [],
        services: [],
        models: [],
        routes: [],
      },
      dataFlow: {
        entryPoints: [],
        services: [],
        dataModels: [],
        utilities: [],
      },
    },
  };

  function processNode(node, parentPath = "") {
    const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;

    if (node.type === "file") {
      const category = categorizeFile(currentPath, node.name);
      if (category) {
        docTemplate.projectStructure.overview[category].push({
          name: node.name,
          path: currentPath,
          size: node.metadata?.size ? formatSize(node.metadata.size) : "N/A",
          lastModified: node.metadata?.modified || "N/A",
        });

        if (node.name.includes("service") || node.name.includes("api")) {
          docTemplate.projectStructure.dataFlow.services.push({
            name: node.name,
            path: currentPath,
          });
        } else if (
          node.name.includes("model") ||
          node.name.includes("schema")
        ) {
          docTemplate.projectStructure.dataFlow.dataModels.push({
            name: node.name,
            path: currentPath,
          });
        } else if (currentPath.includes("/utils/")) {
          docTemplate.projectStructure.dataFlow.utilities.push({
            name: node.name,
            path: currentPath,
          });
        } else if (
          currentPath.includes("index.") ||
          currentPath.includes("main.") ||
          currentPath.includes("app.")
        ) {
          docTemplate.projectStructure.dataFlow.entryPoints.push({
            name: node.name,
            path: currentPath,
          });
        }
      }
    }

    if (node.children) {
      node.children.forEach((child) => processNode(child, currentPath));
    }
  }

  // Process the tree to populate the documentation
  processNode(tree);

  return {
    markdown: generateMarkdown(docTemplate, repoInfo),
    documentation: docTemplate,
  };
}

// Helper function to generate markdown
function generateMarkdown(docTemplate, repoInfo) {
  return `# Project Structure Documentation
Generated on: ${new Date().toLocaleString()}

## Repository Information
- Name: ${repoInfo.repository.name}
- Owner: ${repoInfo.repository.owner}
- Branch: ${repoInfo.repository.branch}

## Project Overview

### Entry Points
${docTemplate.projectStructure.dataFlow.entryPoints
  .map((entry) => `- \`${entry.path}\``)
  .join("\n")}

### Services
${docTemplate.projectStructure.dataFlow.services
  .map((service) => `- \`${service.path}\``)
  .join("\n")}

### Data Models
${docTemplate.projectStructure.dataFlow.dataModels
  .map((model) => `- \`${model.path}\``)
  .join("\n")}

### Components
${docTemplate.projectStructure.overview.components
  .map((comp) => `- \`${comp.path}\``)
  .join("\n")}

### Utilities
${docTemplate.projectStructure.overview.utilities
  .map((util) => `- \`${util.path}\``)
  .join("\n")}

## Data Flow Diagram
\`\`\`mermaid
flowchart TD
  ${docTemplate.projectStructure.dataFlow.entryPoints
    .map((entry) => `Entry[${entry.name}]`)
    .join("\n  ")}
  ${docTemplate.projectStructure.dataFlow.services
    .map((service) => `Service[${service.name}]`)
    .join("\n  ")}
  ${docTemplate.projectStructure.dataFlow.dataModels
    .map((model) => `Model[${model.name}]`)
    .join("\n  ")}
  
  Entry --> Service
  Service --> Model
\`\`\`
`;
}

// Helper functions
function categorizeFile(filePath, fileName) {
  if (fileName.includes(".test.") || fileName.includes(".spec."))
    return "testFiles";
  if (fileName.match(/\.(js|ts|jsx|tsx)$/)) {
    if (filePath.includes("/components/")) return "components";
    if (filePath.includes("/services/")) return "services";
    if (filePath.includes("/utils/")) return "utilities";
    if (filePath.includes("/models/")) return "models";
    if (filePath.includes("/routes/")) return "routes";
    return "sourceFiles";
  }
  if (fileName.match(/\.(json|yaml|yml|env|config)$/)) return "configFiles";
  return null;
}

function formatSize(bytes) {
  const sizes = ["Bytes", "KB", "MB", "GB"];
  if (bytes === 0) return "0 Bytes";
  const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return Math.round(bytes / Math.pow(1024, i), 2) + " " + sizes[i];
}

// API Routes
app.post("/api/github/tree", async (req, res) => {
  try {
    const { repoUrl, format = "json", options = {} } = req.body;

    if (!repoUrl) {
      return res.status(400).json({
        error: "Repository URL is required",
        status: "error",
      });
    }

    let result;

    if (format === "json") {
      const generator = new GitHubJsonTreeGenerator(options);
      result = await generator.generate(repoUrl);

      if (options.generateDocs) {
        const devDocs = await generateDevDocs(result.tree, result);
        result.documentation = devDocs;
      }
    } else {
      result = await GitHubTreeGenerator.generate(repoUrl, options);
    }

    res.json({
      data: result,
      status: "success",
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      status: "error",
    });
  }
});

app.post("/api/filesystem/tree", async (req, res) => {
  try {
    const { path: fsPath, format = "json", options = {} } = req.body;

    if (!fsPath) {
      return res.status(400).json({
        error: "File system path is required",
        status: "error",
      });
    }

    let result;

    if (format === "json") {
      const generator = new FileSystemJsonTreeGenerator(options);
      result = await generator.generateTreeData(fsPath);
    } else {
      result = await TreeGenerator.generate(fsPath, options);
    }

    res.json({
      data: result,
      status: "success",
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      status: "error",
    });
  }
});

app.post("/api/save", async (req, res) => {
  try {
    const { treeData, outputPath, format = "json" } = req.body;

    if (!treeData || !outputPath) {
      return res.status(400).json({
        error: "Tree data and output path are required",
        status: "error",
      });
    }

    if (format === "json") {
      const generator = new GitHubJsonTreeGenerator();
      await generator.saveTreeData(treeData, outputPath);
    } else {
      const generator = new GitHubTreeGenerator();
      generator.writeTreeToFile(treeData, outputPath);
    }

    res.json({
      message: "Tree data saved successfully",
      path: outputPath,
      status: "success",
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      status: "error",
    });
  }
});

// Serve the HTML page at root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Error handler middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: err.message,
    status: "error",
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tree generation service running on port ${PORT}`);
  console.log(`Access the web interface at http://localhost:${PORT}`);
});

module.exports = app;
