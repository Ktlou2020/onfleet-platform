import { brandName } from '../brand';
export default function Logo({ size = 'md', className = '' }) {
  return (
    <div className={`brand-logo ${size === 'lg' ? 'lg' : size === 'xl' ? 'xl' : ''} ${className}`}>
      <img src="/logo.png" alt={brandName} />
    </div>
  );
}
