const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const vendorDir = path.join(publicDir, 'vendor');

function ensureDir(target) {
    fs.mkdirSync(target, { recursive: true });
}

function copyFile(from, to) {
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
    console.log(`Copied ${path.relative(projectRoot, from)} -> ${path.relative(projectRoot, to)}`);
}

function copyDir(from, to) {
    ensureDir(path.dirname(to));
    fs.cpSync(from, to, { recursive: true, force: true });
    console.log(`Copied ${path.relative(projectRoot, from)} -> ${path.relative(projectRoot, to)}`);
}

function source(...segments) {
    return path.join(projectRoot, 'node_modules', ...segments);
}

ensureDir(vendorDir);

copyFile(
    source('bootstrap', 'dist', 'css', 'bootstrap.min.css'),
    path.join(vendorDir, 'bootstrap', 'bootstrap.min.css')
);
copyFile(
    source('bootstrap', 'dist', 'js', 'bootstrap.bundle.min.js'),
    path.join(vendorDir, 'bootstrap', 'bootstrap.bundle.min.js')
);

copyFile(
    source('@fortawesome', 'fontawesome-free', 'css', 'all.min.css'),
    path.join(vendorDir, 'fontawesome', 'css', 'all.min.css')
);
copyDir(
    source('@fortawesome', 'fontawesome-free', 'webfonts'),
    path.join(vendorDir, 'fontawesome', 'webfonts')
);

copyFile(
    source('@fontsource-variable', 'manrope', 'wght.css'),
    path.join(vendorDir, 'fonts', 'manrope', 'wght.css')
);
copyDir(
    source('@fontsource-variable', 'manrope', 'files'),
    path.join(vendorDir, 'fonts', 'manrope', 'files')
);

copyFile(
    source('@fontsource-variable', 'playfair-display', 'wght.css'),
    path.join(vendorDir, 'fonts', 'playfair-display', 'wght.css')
);
copyDir(
    source('@fontsource-variable', 'playfair-display', 'files'),
    path.join(vendorDir, 'fonts', 'playfair-display', 'files')
);

console.log('UI assets built successfully.');
