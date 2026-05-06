export default function Logo({ size = 'md', className = '' }) {
  return (
    <div className={`brand-logo ${size === 'lg' ? 'lg' : size === 'xl' ? 'xl' : ''} ${className}`}>
      <img src="/logo.png" alt="OnFleet" />
    </div>
  );
}
