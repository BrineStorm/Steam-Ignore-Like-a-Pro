// Function to update the UI elements
function updatePopupUI(data) {
    const count = data.spt_ignored_count || 0;
    const lastName = data.spt_last_ignored_name || 'None';
    const source = data.spt_last_ignored_source || 'Unknown';

    document.getElementById('count').textContent = count;
    
    const nameElement = document.getElementById('last-game');
    // Truncate text for display
    nameElement.textContent = truncateText(lastName, 50);
    
    // Set title to include Full Name AND Source
    nameElement.title = `${lastName}\nSource: ${source}`;
}

// Function to truncate long names
function truncateText(text, maxLength) {
    if (!text) return 'None';
    return text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;
}

// 1. Load data when popup opens
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['spt_ignored_count', 'spt_last_ignored_name', 'spt_last_ignored_source'], (result) => {
        updatePopupUI(result);
    });
});

// 2. Listen for changes in real-time (while popup is open)
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        // Construct a new data object from the changes
        const newData = {};
        
        if (changes.spt_ignored_count) newData.spt_ignored_count = changes.spt_ignored_count.newValue;
        if (changes.spt_last_ignored_name) newData.spt_last_ignored_name = changes.spt_last_ignored_name.newValue;
        if (changes.spt_last_ignored_source) newData.spt_last_ignored_source = changes.spt_last_ignored_source.newValue;
        
        // We need to fetch current values for anything that didn't change to avoid undefined
        chrome.storage.local.get(['spt_ignored_count', 'spt_last_ignored_name', 'spt_last_ignored_source'], (current) => {
            const mergedData = { ...current, ...newData };
            updatePopupUI(mergedData);
        });
    }
});