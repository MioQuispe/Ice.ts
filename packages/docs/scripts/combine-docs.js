import fs from 'fs';
import path from 'path';

// Configuration
const SOURCE_DIR = './reference';
const OUTPUT_FILE = 'full.md';

/**
 * Helper function to recursively get all .md files from a directory.
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
 * Main function to combine markdown files.
 */
async function combineMarkdownFiles() {
  try {
    // Check if source directory exists
    if (!fs.existsSync(SOURCE_DIR)) {
      console.error(`Error: Directory "${SOURCE_DIR}" not found.`);
      process.exit(1);
    }

    console.log(`Scanning "${SOURCE_DIR}" recursively for Markdown files...`);

    // Get all md files recursively
    const mdFiles = await getMarkdownFilesRecursively(SOURCE_DIR);

    if (mdFiles.length === 0) {
      console.log('No .md files found in the directory or subdirectories.');
      return;
    }

    console.log(`Found ${mdFiles.length} Markdown files. Combining...`);

    let combinedContent = '';

    // Iterate through files and build content
    for (const filePath of mdFiles) {
      const content = await fs.promises.readFile(filePath, 'utf8');

      // Add a header and separator for each file
      combinedContent += `\n<!-- START FILE: ${filePath} -->\n`;
      combinedContent += `# File: ${filePath}\n\n`;
      combinedContent += content;
      combinedContent += `\n\n---\n\n`; // Horizontal rule to separate files
    }

    // Write the result to output file
    await fs.promises.writeFile(OUTPUT_FILE, combinedContent, 'utf8');

    console.log(`Successfully created "${OUTPUT_FILE}" with content from ${mdFiles.length} files.`);

  } catch (error) {
    console.error('An error occurred:', error);
  }
}

combineMarkdownFiles();
