import React from 'react';

export interface ManualActionReportItem {
  agentName: string;
  sharedWith: string[];
  unmappedDatastores: string[];
}

interface PostRestoreStepsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  report: ManualActionReportItem[];
}

const PostRestoreStepsDrawer: React.FC<PostRestoreStepsDrawerProps> = ({
  isOpen,
  onClose,
  report,
}) => {
  const downloadStepsAsText = () => {
    let content = "Post-Restore Steps\n";
    content += "==================\n\n";
    content += "Please complete the following manual steps to finalize your restoration.\n\n";

    report.forEach(item => {
      content += `🤖 Agent: "${item.agentName}"\n`;
      content += `----------------------------------------\n`;
      content += `- Status: All restored agents are in draft and will need to be created/published.\n`;
      
      if (item.sharedWith && item.sharedWith.length > 0) {
        content += `- Sharing: Please reshare this agent with:\n`;
        item.sharedWith.forEach(email => {
          content += `    * ${email}\n`;
        });
      } else {
        content += `- Sharing: No sharing permissions found in backup.\n`;
      }

      if (item.unmappedDatastores && item.unmappedDatastores.length > 0) {
        content += `- Unmapped Datastores: The following datastores could not be remapped and need manual review:\n`;
        item.unmappedDatastores.forEach(dsId => {
          content += `    * ${dsId}\n`;
        });
      } else {
        content += `- Datastores: All datastores were successfully mapped or none were attached.\n`;
      }
      content += `\n`;
    });

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `post_restore_steps.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden" aria-labelledby="slide-over-title" role="dialog" aria-modal="true">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-gray-500 bg-opacity-75 transition-opacity" aria-hidden="true" onClick={onClose}></div>

        <div className="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10">
          <div className="pointer-events-auto w-screen max-w-md">
            <div className="flex h-full flex-col overflow-y-scroll bg-white/90 backdrop-blur-md shadow-2xl border-l border-white/20">
              <div className="flex-1 py-6 px-4 sm:px-6">
                <div className="flex items-start justify-between">
                  <h2 className="text-lg font-bold text-gray-900" id="slide-over-title">Post-Restore Steps</h2>
                  <div className="ml-3 flex h-7 items-center">
                    <button
                      type="button"
                      className="rounded-md bg-white text-gray-400 hover:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                      onClick={onClose}
                    >
                      <span className="sr-only">Close panel</span>
                      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="mt-1">
                  <p className="text-sm text-gray-500">
                    Complete these manual steps to finalize your restoration.
                  </p>
                </div>

                <div className="mt-6 space-y-6">
                  {report.map((item, idx) => (
                    <div key={idx} className="bg-white/50 backdrop-blur-sm p-4 rounded-xl border border-gray-100 shadow-sm space-y-3">
                      <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                        <span className="text-blue-500">🤖</span> {item.agentName}
                      </h3>
                      
                      <div className="text-xs text-gray-600">
                        <p className="font-medium text-yellow-700 bg-yellow-50 p-2 rounded-lg border border-yellow-100">
                          ℹ️ All restored agents are in draft and will need to be created/published.
                        </p>
                      </div>

                      {item.sharedWith && item.sharedWith.length > 0 ? (
                        <div>
                          <h4 className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1">
                            <span className="text-purple-500">👥</span> Reshare with:
                          </h4>
                          <div className="flex flex-wrap gap-1">
                            {item.sharedWith.map((user, uidx) => (
                              <span key={uidx} className="px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded text-[10px] font-medium">
                                {user}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs text-gray-500 flex items-center gap-1">
                          <span className="text-purple-300">👥</span> No sharing permissions found in backup.
                        </div>
                      )}

                      {item.unmappedDatastores && item.unmappedDatastores.length > 0 ? (
                        <div>
                          <h4 className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1">
                            <span className="text-red-500">📦</span> Unmapped Datastores (Action Required):
                          </h4>
                          <ul className="space-y-1 text-xs text-gray-600">
                            {item.unmappedDatastores.map((dsId, dsIdx) => (
                              <li key={dsIdx} className="font-mono text-gray-500 bg-red-50 px-1.5 py-0.5 rounded border border-red-100 inline-block mr-1 mb-1">
                                {dsId}
                              </li>
                            ))}
                          </ul>
                          <p className="text-[10px] text-red-500 mt-1">
                            These datastores were not able to be remapped to new datastores and will need to be reviewed and manually re-added.
                          </p>
                        </div>
                      ) : (
                        <div className="text-xs text-gray-500 flex items-center gap-1">
                          <span className="text-green-500">📦</span> All datastores successfully mapped or none attached.
                        </div>
                      )}
                    </div>
                  ))}

                  {report.length === 0 && (
                    <div className="text-center py-6 text-gray-500 text-sm">
                      No manual steps required! All items were successfully restored.
                    </div>
                  )}
                </div>
              </div>

              <div className="border-t border-gray-200 py-6 px-4 sm:px-6 bg-gray-50/80 backdrop-blur-sm rounded-b-2xl">
                <div className="flex justify-between gap-3">
                  <button
                    onClick={downloadStepsAsText}
                    className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors shadow-sm flex items-center justify-center gap-2"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download Steps
                  </button>
                  <button
                    onClick={onClose}
                    className="px-4 py-2.5 bg-white hover:bg-gray-50 text-gray-700 text-sm font-semibold rounded-lg border border-gray-300 transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PostRestoreStepsDrawer;
