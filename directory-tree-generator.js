const fs = require("fs");
const path = require("path");

function generateTree(
  startPath,
  indent = "",
  excludePatterns = ["node_modules", "package.json", "package-lock.json"]
) {
  let output = "";
  const files = fs.readdirSync(startPath);

  files.forEach((file, index) => {
    // Skip excluded patterns
    if (excludePatterns.some((pattern) => file.includes(pattern))) {
      return;
    }

    const filePath = path.join(startPath, file);
    const stats = fs.statSync(filePath);
    const isLast = index === files.length - 1;

    // Create appropriate prefix
    const prefix = indent + (isLast ? "└── " : "├── ");

    // Add file/directory to output
    output += `${prefix}${file}\n`;

    // If it's a directory, recurse into it
    if (stats.isDirectory()) {
      // Create new indent for subdirectories
      const newIndent = indent + (isLast ? "    " : "│   ");
      output += generateTree(filePath, newIndent, excludePatterns);
    }
  });

  return output;
}

function generateMarkdownDoc(treePath, treeContent) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `# Directory Structure Documentation
Generated on: ${new Date().toLocaleString()}
Directory: ${treePath}

## Project Tree
\`\`\`
${treeContent}
\`\`\`

## Directory Details

This documentation shows the structure of your project directory, excluding:
- node_modules
- package.json
- package-lock.json

You can regenerate this documentation by running:
\`\`\`bash
node tree-generator.js [path-to-directory]
\`\`\`
`;
}

function main() {
  // Get directory path from command line argument or use current directory
  const targetPath = process.argv[2] || ".";

  try {
    // Resolve the full path
    const fullPath = path.resolve(targetPath);

    // Check if directory exists
    if (!fs.existsSync(fullPath)) {
      console.error(`Error: Directory "${fullPath}" does not exist`);
      process.exit(1);
    }

    // Generate tree content
    const treeContent = generateTree(fullPath);

    // Create docs directory if it doesn't exist
    const docsDir = path.join(fullPath, "docs");
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir);
    }

    // Generate markdown documentation
    const markdownContent = generateMarkdownDoc(fullPath, treeContent);

    // Save markdown file
    const timestamp = new Date().toISOString().split("T")[0];
    const docPath = path.join(docsDir, `directory-structure-${timestamp}.md`);
    fs.writeFileSync(docPath, markdownContent);

    // Print the tree and success message
    console.log(`Directory tree for: ${fullPath}`);
    console.log();
    console.log(treeContent);
    console.log(`\nDocumentation saved to: ${docPath}`);
  } catch (error) {
    console.error("Error generating directory tree:", error.message);
    process.exit(1);
  }
}

// Run the application
main();
