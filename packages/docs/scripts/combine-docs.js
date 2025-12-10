import fs from 'fs';
import path from 'path';

// Configuration
const OUTPUT_FILE = 'full.md';

/**
 * Get source paths from command line arguments or use default.
 * @returns {string[]} Array of source paths (files and/or directories)
 */
function getSourcePaths() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    return ['./reference'];
  }
  return args;
}

/**
 * Helper function to recursively get all .md files from a directory.
 * @param {string} dir - Directory path to scan
 * @returns {Promise<string[]>} Array of markdown file paths
 */
async function getMarkdownFilesRecursively(dir) {
  let results = [];
  // Read the directory
  const list = await fs.promises.readdir(dir, { withFileTypes: true });
  
  for (const dirent of list) {
    const res = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      // Recurse into subdirectory
      results = results.concat(await getMarkdownFilesRecursively(res));
    } else {
      // Check if file is markdown
      if (path.extname(res).toLowerCase() === '.md') {
        results.push(res);
      }
    }
  }
  return results;
}

/**
 * Process a single source path (file or directory) and return all markdown files.
 * @param {string} sourcePath - Path to a file or directory
 * @returns {Promise<string[]>} Array of markdown file paths
 */
async function processSourcePath(sourcePath) {
  const resolvedPath = path.resolve(sourcePath);
  
  // Check if path exists
  if (!fs.existsSync(resolvedPath)) {
    console.warn(`Warning: Path "${sourcePath}" does not exist. Skipping.`);
    return [];
  }
  
  const stats = await fs.promises.stat(resolvedPath);
  
  if (stats.isDirectory()) {
    // If it's a directory, recursively get all .md files
    return await getMarkdownFilesRecursively(resolvedPath);
  } else if (stats.isFile()) {
    // If it's a file, check if it's a markdown file
    if (path.extname(resolvedPath).toLowerCase() === '.md') {
      return [resolvedPath];
    } else {
      console.warn(`Warning: "${sourcePath}" is not a markdown file. Skipping.`);
      return [];
    }
  }
  
  return [];
}

/**
 * Main function to combine markdown files.
 */
async function combineMarkdownFiles() {
  try {
    const sourcePaths = getSourcePaths();
    
    console.log(`Processing ${sourcePaths.length} source path(s): ${sourcePaths.join(', ')}`);

    // Process all source paths and collect markdown files
    const allMdFiles = [];
    for (const sourcePath of sourcePaths) {
      const mdFiles = await processSourcePath(sourcePath);
      allMdFiles.push(...mdFiles);
    }

    // Remove duplicates (in case a file is specified multiple times)
    const uniqueMdFiles = [...new Set(allMdFiles)];

    if (uniqueMdFiles.length === 0) {
      console.log('No .md files found in the specified paths.');
      return;
    }

    console.log(`Found ${uniqueMdFiles.length} Markdown file(s). Combining...`);

    let combinedContent = '';

    // Iterate through files and build content
    for (const filePath of uniqueMdFiles) {
      const content = await fs.promises.readFile(filePath, 'utf8');

      // Add a header and separator for each file
      combinedContent += `\n<!-- START FILE: ${filePath} -->\n`;
      combinedContent += `# File: ${filePath}\n\n`;
      combinedContent += content;
      combinedContent += `\n\n---\n\n`; // Horizontal rule to separate files
    }

    // Write the result to output file
    await fs.promises.writeFile(OUTPUT_FILE, combinedContent, 'utf8');

    console.log(`Successfully created "${OUTPUT_FILE}" with content from ${uniqueMdFiles.length} file(s).`);

  } catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
  }
}

combineMarkdownFiles();
