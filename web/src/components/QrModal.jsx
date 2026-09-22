import { AnimatePresence, motion } from 'framer-motion';
import QRCode from 'qrcode.react';
import { DOWNLOAD } from '../constants';

export default function QrModal({ file, version, onClose }) {
    return (
        <AnimatePresence>
            {file && (
                <motion.div
                    className="qr-modal-overlay"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={onClose}
                >
                    <motion.div
                        className="qr-modal-content"
                        initial={{ opacity: 0, y: 32 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 24 }}
                        role="dialog"
                        aria-modal="true"
                        aria-label="二维码下载"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h4>扫码下载</h4>
                        <p className="qr-file">{file}</p>
                        <QRCode
                            value={`${window.location.origin}${DOWNLOAD}/${version}/${file}`}
                            size={220}
                        />
                        <button type="button" className="qr-modal-close" onClick={onClose}>
                            关闭
                        </button>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
