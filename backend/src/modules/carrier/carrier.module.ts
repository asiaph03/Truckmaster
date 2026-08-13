import { Module } from '@nestjs/common';
import { CarrierController } from './controllers/carrier.controller';
import { CarrierService } from './services/carrier.service';
import { CarrierEligibilityService } from './services/carrier-eligibility.service';

@Module({
  controllers: [CarrierController],
  providers: [CarrierService, CarrierEligibilityService],
  exports: [CarrierService, CarrierEligibilityService],
})
export class CarrierModule {}
