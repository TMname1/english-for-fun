import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";

import { MasteredElementService } from "./mastered-element.service";
import { AddMasteredElementDto } from "./model/add-mastered-element.dto";
import { RemoveMasteredElementDto } from "./model/remove-mastered-element.dto";

@Controller("mastered-elements")
export class MasteredElementController {
  constructor(private readonly masteredElementService: MasteredElementService) {}

  @Post()
  async addMasteredElement(@Body() addMasteredElementDto: AddMasteredElementDto) {
    return await this.masteredElementService.addMasteredElement(addMasteredElementDto.content);
  }

  @Get()
  async getMasteredElements() {
    return await this.masteredElementService.getMasteredElements();
  }

  @Delete(":elementId")
  async removeMasteredElement(@Param() removeMasteredElementDto: RemoveMasteredElementDto) {
    return await this.masteredElementService.removeMasteredElement(
      removeMasteredElementDto.elementId,
    );
  }
}
